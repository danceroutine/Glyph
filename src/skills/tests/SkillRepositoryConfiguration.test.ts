import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { basename, join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { captureRepositoryEnvironment } from '#src/skills/SkillRepositoryConfiguration.js';
import { trustedHostExecutable } from '#src/shell/TrustedHostExecutable.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';

afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'glyph-git-configuration-'));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const project = join(base, 'project');
  const preview = join(base, 'preview');
  for (const path of [home, project, preview]) await mkdir(path, { mode: 0o700 });
  const global = join(home, 'global.config');
  await writeFile(global, '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', undefined);
  vi.stubEnv('GIT_CONFIG_GLOBAL', global);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  const capture = () =>
    captureRepositoryEnvironment([project], preview, new AbortController().signal, testFilesystemMetadata);
  return { home, project, preview, global, capture };
}

it('rejects active transitive includes from writable workspaces before a transport can use their settings', async () => {
  const f = await fixture();
  const included = join(f.home, 'included.config');
  await writeFile(f.global, '[include]\npath = included.config\n');
  await writeFile(included, `[include]\npath = ${join(f.project, 'workspace.config')}\n`);
  await writeFile(join(f.project, 'workspace.config'), '[user]\nname = Workspace controlled\n');
  await expect(f.capture()).rejects.toThrow('outside writable workspaces');
});

it('pins trusted include values, repeated values, bare booleans and escaped subsection strings for the entire preview', async () => {
  const f = await fixture();
  const included = join(f.home, 'included.config');
  await writeFile(f.global, '[include]\npath = included.config\n[user]\nname = Trusted user\n[fetch]\nprune\n');
  await writeFile(
    included,
    '[credential]\nhelper = store\nhelper = cache\n[url "https://trusted.invalid/a"]\ninsteadOf = "https://example.invalid/\\t\\n\\b\\\\\\\""\n',
  );
  const environment = await f.capture();
  const git = (...args: string[]) =>
    execFileSync(trustedHostExecutable('git', [f.project]), ['config', ...args], {
      cwd: f.preview,
      env: environment,
      encoding: 'utf8',
    });
  expect(git('--get-all', 'credential.helper')).toMatch(
    /^!exec '[^\n]+git-credential-store'\n!exec '[^\n]+git-credential-cache'\n$/u,
  );
  expect(git('--bool', '--get', 'fetch.prune')).toBe('true\n');
  expect(git('--get', 'user.name')).toBe('Trusted user\n');
  expect(git('--get', 'url.https://trusted.invalid/a.insteadOf')).toBe('https://example.invalid/\t\n\b\\"\n');
  await writeFile(included, '[user]\nname = Changed after capture\n');
  await writeFile(f.global, `[include]\npath = ${join(f.project, 'later.config')}\n`);
  expect(git('--get', 'user.name')).toBe('Trusted user\n');
  expect(await readFile(environment.GIT_CONFIG_GLOBAL!, 'utf8')).not.toContain('[include]');
});

it('keeps an empty configuration private and propagates cancellation and metadata rejection', async () => {
  const f = await fixture();
  const environment = await f.capture();
  expect(await readFile(environment.GIT_CONFIG_GLOBAL!, 'utf8')).toBe('');
  await expect(
    captureRepositoryEnvironment([f.project], f.preview, new AbortController().signal, {
      assertHostPaths: async () => {},
      inspect: async () => {
        throw new Error('Inherited ACL');
      },
    }),
  ).rejects.toThrow('Inherited ACL');
  const controller = new AbortController();
  controller.abort();
  await expect(
    captureRepositoryEnvironment([f.project], f.preview, controller.signal, testFilesystemMetadata),
  ).rejects.toThrow();
});

it('removes conditional directives containing a Unicode line separator and retains literal subsection characters', async () => {
  const f = await fixture();
  const separator = String.fromCodePoint(0x2028);
  const subsection = 'one\ttwo\bthree' + String.fromCodePoint(92) + 'four';
  const repository = 'project' + separator + 'name.git';
  const condition = 'gitdir:**/' + repository;
  const git = trustedHostExecutable('git', [f.project]);
  execFileSync(git, ['init', '--bare', '--quiet', '--template=', repository], { cwd: f.preview });
  const included = join(f.home, 'future.config');
  await writeFile(included, '[user]\nname = First\n');
  const settings = ['config', '--file', f.global];
  execFileSync(git, [...settings, 'includeif.' + condition + '.path', 'future.config']);
  execFileSync(git, [...settings, 'example.' + subsection + '.value', 'preserved']);
  const env = await captureRepositoryEnvironment(
    [f.project],
    f.preview,
    new AbortController().signal,
    testFilesystemMetadata,
    repository,
  );
  await writeFile(included, '[user]\nname = Second\n');
  expect(execFileSync(git, ['config', '--get', 'user.name'], { cwd: f.preview, env, encoding: 'utf8' }).trim()).toBe(
    'First',
  );
  expect(await readFile(env.GIT_CONFIG_GLOBAL!, 'utf8')).not.toContain('future.config');
  expect(
    execFileSync(git, ['config', '--get', 'example.' + subsection + '.value'], {
      cwd: f.preview,
      env,
      encoding: 'utf8',
    }).trim(),
  ).toBe('preserved');
});

it('rejects settings whose bytes cannot round-trip through a UTF-8 configuration snapshot', async () => {
  const f = await fixture();
  await writeFile(f.global, Buffer.concat([Buffer.from('[user]\nname = '), Buffer.from([0xff]), Buffer.from('\n')]));
  await expect(f.capture()).rejects.toThrow(/utf-8/iu);
});

it('uses an admitted absolute helper without evaluating its filename as shell syntax', async () => {
  const f = await fixture();
  const helper = join(f.home, "host'helper");
  await writeFile(helper, "#!/bin/sh\nprintf 'username=fixture\\npassword=fixture\\n'\n");
  await chmod(helper, 0o700);
  await writeFile(f.global, `[credential]\nhelper = ${helper}\n`);
  const env = await f.capture();
  expect(
    execFileSync(trustedHostExecutable('git', []), ['credential', 'fill'], {
      cwd: f.preview,
      env,
      input: 'protocol=https\nhost=fixture.invalid\n\n',
      encoding: 'utf8',
    }),
  ).toContain('username=fixture\npassword=fixture');
});

it('refuses workspace-controlled helpers and shell fragments before transport can execute them', async () => {
  const f = await fixture();
  const helper = join(f.project, 'helper');
  await writeFile(helper, '#!/bin/sh\nexit 0\n');
  await chmod(helper, 0o700);
  await writeFile(f.global, `[credential]\nhelper = ${helper}\n`);
  await expect(f.capture()).rejects.toThrow('outside writable workspaces');
  for (const value of ['!echo unreviewed', 'store --file credentials']) {
    await writeFile(f.global, `[credential]\nhelper = ${value}\n`);
    await expect(f.capture()).rejects.toThrow('without arguments');
  }
  await writeFile(f.global, `[credential]\nhelper = ${f.home}\n`);
  await expect(f.capture()).rejects.toThrow('executable file');
});

it('retains credential reset entries and blocks command-valued transport overrides', async () => {
  const f = await fixture();
  await writeFile(f.global, '[credential]\nhelper =\n[remote "origin"]\nproxy = http://fixture.invalid:8080\n');
  const env = await f.capture();
  expect(
    execFileSync(trustedHostExecutable('git', []), ['config', '--get-all', 'credential.helper'], {
      cwd: f.preview,
      env,
      encoding: 'utf8',
    }),
  ).toBe('\n');
  expect(
    execFileSync(trustedHostExecutable('git', []), ['config', '--get', 'remote.origin.proxy'], {
      cwd: f.preview,
      env,
      encoding: 'utf8',
    }),
  ).toBe('http://fixture.invalid:8080\n');
  for (const [section, key] of [
    ['core', 'sshCommand'],
    ['core', 'gitProxy'],
    ['core', 'askPass'],
    ['core', 'alternateRefsCommand'],
    ['uploadpack', 'packObjectsHook'],
    ['remote "origin"', 'uploadpack'],
    ['remote "origin"', 'vcs'],
  ]) {
    await writeFile(f.global, `[${section}]\n${key} = arbitrary-command\n`);
    await expect(f.capture()).rejects.toThrow('command-valued Git transport');
  }
});

it('uses trusted HTTPS-to-file mirrors and rejects SSH rewrites when the SSH client lacks authority', async () => {
  const f = await fixture();
  const git = trustedHostExecutable('git', []);
  const mirror = join(f.home, 'mirror.git');
  execFileSync(git, ['init', '--bare', '--quiet', '--template=', mirror]);
  await writeFile(
    f.global,
    [
      '[url "' + pathToFileURL(mirror).toString() + '"]',
      'insteadOf = https://mirror.invalid/fixture',
      '[url "ssh://127.0.0.1:1/fixture"]',
      'insteadOf = https://ssh.invalid/fixture',
      '[protocol "ssh"]',
      'allow = always',
    ].join('\n'),
  );
  // A host can have Git installed while SSH is unavailable or belongs to a peer workspace.
  const metadata = {
    ...testFilesystemMetadata,
    assertHostPaths: async (paths: readonly string[]) => {
      if (paths.length === 1 && ['ssh', 'ssh.exe'].includes(basename(paths[0]!).toLowerCase()))
        throw new Error('SSH unavailable');
    },
  };
  const env = await captureRepositoryEnvironment([f.project], f.preview, new AbortController().signal, metadata);
  expect(env.GIT_ALLOW_PROTOCOL).toBe('https:file');
  const lsRemote = (url: string) => spawnSync(git, ['ls-remote', url], { env, cwd: f.preview, encoding: 'utf8' });
  expect(lsRemote('https://mirror.invalid/fixture').status).toBe(0);
  expect(lsRemote('https://ssh.invalid/fixture').stderr).toContain("transport 'ssh' not allowed");
});
