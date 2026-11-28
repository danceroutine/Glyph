import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { captureRepositoryEnvironment } from '#src/skills/SkillRepositoryConfiguration.js';
import { HostProcessLeases } from '#src/shell/HostProcessLeases.js';
import { HostExecutionAuthority } from '#src/shell/HostExecutionAuthority.js';
import { Deferred } from '#src/shared/Deferred.js';
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
  execFileSync(git, [...settings, 'credential.' + subsection + '.username', 'preserved']);
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
    execFileSync(git, ['config', '--get', 'credential.' + subsection + '.username'], {
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

it.each(['https://fixture.invalid/package', 'ssh://git@fixture.invalid/package', 'git@fixture.invalid:package'])(
  'admits SSH inputs only when the configured remote selects SSH at %s',
  async remote => {
    const f = await fixture();
    const git = trustedHostExecutable('git', []);
    const url = 'https://package.invalid/selected';
    execFileSync(git, ['init', '--bare', '--quiet', '--template=', 'source.git'], { cwd: f.preview });
    execFileSync(git, ['--git-dir=source.git', 'remote', 'add', 'origin', url], { cwd: f.preview });
    await writeFile(f.global, `[url "${remote}"]\ninsteadOf = ${url}\n`);
    const socket = join(f.project, 'agent');
    vi.stubEnv('SSH_AUTH_SOCK', socket);
    const select = vi.fn();
    const admitted = vi.fn(testFilesystemMetadata.assertHostPaths);
    const metadata = { ...testFilesystemMetadata, assertHostPaths: admitted };
    const capture = (roots: string[]) =>
      captureRepositoryEnvironment(
        roots,
        f.preview,
        new AbortController().signal,
        metadata,
        'source.git',
        new HostExecutionAuthority(roots, metadata),
        select,
      );
    const keyDirectory = join(userInfo().homedir, '.ssh');
    if (remote.startsWith('https:')) {
      const env = await capture([f.project, keyDirectory]);
      expect(env.GIT_ALLOW_PROTOCOL).toBe('https');
      expect(env.GIT_SSH_COMMAND).toBeUndefined();
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
    } else {
      await expect(capture([f.project])).rejects.toThrow('outside writable workspaces');
      await expect(capture([keyDirectory])).rejects.toThrow('outside writable workspaces');
      const env = await capture([]);
      expect(env.GIT_ALLOW_PROTOCOL).toBe('ssh');
      const command = env.GIT_SSH_COMMAND!;
      const options = execFileSync('/bin/sh', ['-c', command + ' -G fixture.invalid'], { env, encoding: 'utf8' });
      expect(options).toContain('identityfile ' + join(keyDirectory, 'id_ed25519'));
      expect(options).toContain('userknownhostsfile ' + join(keyDirectory, 'known_hosts'));
      expect(options).toContain('globalknownhostsfile /etc/ssh/ssh_known_hosts');
      expect(options).toMatch(/^identityagent SSH_AUTH_SOCK$/mu);
      expect(env.SSH_AUTH_SOCK).toBe(join(await realpath(f.project), 'agent'));
      expect(admitted).toHaveBeenCalledWith(
        expect.arrayContaining([
          join(keyDirectory, 'id_ed25519.pub'),
          join(keyDirectory, 'id_ed25519-cert.pub'),
          socket,
        ]),
        [],
        expect.arrayContaining([socket]),
      );
      vi.stubEnv('SSH_AUTH_SOCK', 'relative');
      await expect(capture([])).rejects.toThrow('absolute socket path');
      vi.stubEnv('SSH_AUTH_SOCK', undefined);
      const noAgent = await capture([]);
      expect(noAgent.GIT_SSH_COMMAND).toContain('IdentityAgent=none');
    }
    expect(select).not.toHaveBeenCalled();
  },
);

it.each([
  'cookieFile',
  'sslCert',
  'sslKey',
  'sslCAInfo',
  'proxySSLCert',
  'proxySSLKey',
  'proxySSLCAInfo',
  'pinnedPubkey',
])('rejects URL-scoped HTTP %s controlled by a workspace', async option => {
  const f = await fixture();
  await writeFile(f.global, '[http "https://remote.invalid"]\n' + option + ' = ' + join(f.project, 'fixture') + '\n');
  await expect(f.capture()).rejects.toThrow('outside writable workspaces');
});

it('retains hash pins and leases home-relative cookies from capture through the end of transport', async () => {
  const f = await fixture();
  const hashes = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)]
    .map(bytes => 'sha256//' + bytes.toString('base64'))
    .join(';');
  await writeFile(
    f.global,
    '[http]\npinnedPubkey = "' +
      hashes +
      '"\nsaveCookies = true\n[http "https://remote.invalid"]\ncookieFile = ~/jar\n',
  );
  const leases = new HostProcessLeases([f.project]);
  const authority = new HostExecutionAuthority(leases, testFilesystemMetadata);
  const signal = new AbortController().signal;
  const env = await captureRepositoryEnvironment(
    [f.project],
    f.preview,
    signal,
    testFilesystemMetadata,
    undefined,
    authority,
  );
  const get = (key: string) =>
    execFileSync(trustedHostExecutable('git', []), ['config', '--get', key], {
      cwd: f.preview,
      env,
      encoding: 'utf8',
    }).trim();
  const jar = join(await realpath(f.home), 'jar');
  expect(get('http.https://remote.invalid.cookieFile')).toBe(jar);
  expect(get('http.saveCookies')).toBe('true');
  expect(get('http.pinnedPubkey')).toBe(hashes);
  const started = new Deferred<void>();
  const stopped = new Deferred<void>();
  const close = new Deferred<void>();
  const transport = authority.run(signal, processSignal => {
    processSignal.addEventListener(
      'abort',
      () => {
        stopped.resolve();
      },
      { once: true },
    );
    started.resolve();
    return close.promise;
  });
  const rejected = expect(transport).rejects.toThrow('workspace is attaching');
  await started.promise;
  const publish = vi.fn();
  const admission = leases.admitWorkspace(() => [jar], publish);
  await stopped.promise;
  expect(publish).not.toHaveBeenCalled();
  close.resolve();
  await Promise.all([rejected, admission]);
  expect(publish).toHaveBeenCalledOnce();
});

it.each([['cookieFile', 'relative']])('requires an unambiguous host path for HTTP %s', async (key, value) => {
  const f = await fixture();
  await writeFile(f.global, '[http]\n' + key + ' = ' + value + '\n');
  await expect(f.capture()).rejects.toThrow('one absolute path');
});

it('requires an admitted CA bundle and a network endpoint for configured proxies', async () => {
  const f = await fixture();
  await writeFile(f.global, '[http]\nsslCAPath = ' + f.home + '\n');
  await expect(f.capture()).rejects.toThrow('sslCAInfo certificate bundle');
  for (const section of ['http "https://remote.invalid"', 'remote "origin"']) {
    await writeFile(f.global, '[' + section + ']\nproxy = socks5h://localhost/socket\n');
    await expect(f.capture()).rejects.toThrow('network proxy endpoints');
  }
  await writeFile(f.global, '');
  vi.stubEnv('http_proxy', 'socks4a://localhost/socket');
  await expect(f.capture()).rejects.toThrow('network proxy endpoints');
});

it('captures only preview settings from the XDG and home config in precedence order', async () => {
  const f = await fixture();
  vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
  const xdg = join(f.home, 'xdg');
  vi.stubEnv('XDG_CONFIG_HOME', xdg);
  await mkdir(join(xdg, 'git'), { recursive: true });
  await writeFile(join(xdg, 'git/config'), '[http]\nextraHeader = X-Fixture: xdg\n');
  await writeFile(
    join(f.home, '.gitconfig'),
    '[http]\nextraHeader = X-Fixture: home\n[color]\nui = always\n[alias]\nstatusfixture = status\n',
  );
  const env = await f.capture();
  expect(
    execFileSync(trustedHostExecutable('git', []), ['config', '--get-all', 'http.extraHeader'], {
      env,
      cwd: f.preview,
      encoding: 'utf8',
    }),
  ).toBe('X-Fixture: xdg\nX-Fixture: home\n');
  expect(await readFile(env.GIT_CONFIG_GLOBAL!, 'utf8')).not.toMatch(/\[color\]|\[alias\]/u);
});

it.each([
  '.netrc',
  '.git-credentials',
  '.git-credentials.lock',
  '.config/git/credentials',
  '.config/git/credentials.lock',
])('leases the future HTTPS credential path %s until the current process closes', async relative => {
  const f = await fixture();
  const git = trustedHostExecutable('git', []);
  execFileSync(git, ['init', '--bare', '--quiet', '--template=', 'source.git'], { cwd: f.preview });
  execFileSync(git, ['--git-dir=source.git', 'remote', 'add', 'origin', 'https://fixture.invalid/repo'], {
    cwd: f.preview,
  });
  await writeFile(f.global, '[credential]\nhelper = store\n');
  const leases = new HostProcessLeases([]);
  const authority = new HostExecutionAuthority(leases, testFilesystemMetadata);
  const signal = new AbortController().signal;
  await captureRepositoryEnvironment([], f.preview, signal, testFilesystemMetadata, 'source.git', authority, vi.fn());
  const started = new Deferred<void>();
  const stopped = new Deferred<void>();
  const close = new Deferred<void>();
  const process = authority.run(signal, current => {
    current.addEventListener(
      'abort',
      () => {
        stopped.resolve();
      },
      { once: true },
    );
    started.resolve();
    return close.promise;
  });
  const rejected = expect(process).rejects.toThrow('workspace is attaching');
  await started.promise;
  const publish = vi.fn();
  const attach = leases.admitWorkspace(() => [join(f.home, relative)], publish);
  await stopped.promise;
  expect(publish).not.toHaveBeenCalled();
  close.resolve();
  await Promise.all([rejected, attach]);
  expect(publish).toHaveBeenCalledOnce();
});

it('honors a disabled global config and retains transport integrity and ref visibility controls', async () => {
  const f = await fixture();
  await writeFile(f.global, '[fetch]\nfsckObjects = true\n[uploadpack]\nhideRefs = refs/private\n');
  const configured = await f.capture();
  const settings = await readFile(configured.GIT_CONFIG_GLOBAL!, 'utf8');
  expect(settings).toContain('fsckobjects = "true"');
  expect(settings).toContain('hiderefs = "refs/private"');
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  const admitted = vi.fn(testFilesystemMetadata.assertHostPaths);
  const env = await captureRepositoryEnvironment([], f.preview, new AbortController().signal, {
    ...testFilesystemMetadata,
    assertHostPaths: admitted,
  });
  expect(await readFile(env.GIT_CONFIG_GLOBAL!, 'utf8')).toBe('');
  expect(admitted.mock.calls.flatMap(call => call[0])).not.toContain('/dev/null');
});
