import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { chmod, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, vi, onTestFinished } from 'vitest';
import { HostProcessLeases } from '#src/shell/HostProcessLeases.js';
import { SkillRepositoryGit } from '#src/skills/SkillRepositoryGit.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'glyph-git-budget-'));
  const config = join(directory, 'trusted.config');
  await writeFile(config, '');
  vi.stubEnv('HOME', directory);
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
it('rechecks frozen configuration authority when a peer attaches its dotfiles checkout', async () => {
  const root = await fixture();
  const preview = join(root, 'preview');
  const dotfiles = join(root, 'dotfiles');
  await mkdir(preview);
  await mkdir(dotfiles);
  const config = join(dotfiles, 'git.config');
  await writeFile(config, '[user]\nname = Host identity\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  let roots: string[] = [];
  const transport = new SkillRepositoryGit(preview, new AbortController().signal, () => roots, testFilesystemMetadata);
  expect((await transport.run(['--version'])).toString()).toContain('git version');
  roots = [dotfiles];
  await expect(transport.run(['--version'])).rejects.toThrow('outside writable workspaces');
});
it('rejects a repository object store over budget before starting another object fetch', async () => {
  const root = await fixture();
  await writeFile(join(root, 'objects.pack'), Buffer.alloc(32 * 1024 * 1024 + 1));
  await expect(
    new SkillRepositoryGit(root, new AbortController().signal, [], testFilesystemMetadata).run(['version']),
  ).rejects.toThrow('32 MiB');
});
it.skipIf(process.platform === 'win32')(
  'terminates Git transport helpers and settles cancellation before returning',
  async () => {
    const root = await fixture();
    const cancel = new AbortController();
    const result = new SkillRepositoryGit(root, cancel.signal, [], testFilesystemMetadata).run([
      '-c',
      'alias.wait-for-cancel=!sleep 30 & echo $! > helper-pid; wait',
      'wait-for-cancel',
    ]);
    let helper = 0;
    await vi.waitFor(async () => {
      helper = Number(await readFile(join(root, 'helper-pid'), 'utf8'));
      expect(helper).toBeGreaterThan(0);
    });
    cancel.abort(new Error('Read cancelled'));
    await expect(result).rejects.toThrow('Read cancelled');
    await vi.waitFor(() => {
      expect(() => process.kill(helper, 0)).toThrow();
    });
  },
);
it.skipIf(process.platform === 'win32')(
  'holds the configured credential helper through transport close and releases it for the next preview',
  async () => {
    const base = await fixture();
    const cwd = join(base, 'preview');
    const helpers = join(base, 'helpers');
    await Promise.all([mkdir(cwd), mkdir(helpers)]);
    const helper = join(helpers, 'fixture-helper');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o700);
    await writeFile(join(base, 'trusted.config'), '[credential]\nhelper = ' + helper + '\n');
    let roots: string[] = [];
    const leases = new HostProcessLeases(() => roots);
    const cancel = new AbortController();
    onTestFinished(() => {
      cancel.abort();
    });
    const transport = new SkillRepositoryGit(cwd, cancel.signal, leases, testFilesystemMetadata);
    const running = transport.run([
      '-c',
      'alias.wait-for-peer=!sleep 30 & echo $! > helper-pid; wait',
      'wait-for-peer',
    ]);
    const rejected = expect(running).rejects.toThrow('workspace is attaching');
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(join(cwd, 'helper-pid'), 'utf8'));
      expect(pid).toBeGreaterThan(0);
    });
    await leases.admitWorkspace(
      () => [helpers],
      () => {
        roots = [helpers];
      },
    );
    await rejected;
    await vi.waitFor(() => {
      expect(() => process.kill(pid, 0)).toThrow();
    });
    await expect(transport.run(['--version'])).rejects.toThrow('outside writable workspaces');
    roots = [];
    expect((await transport.run(['--version'])).toString()).toContain('git version');
  },
);
it('bounds each Git object read and propagates missing-command diagnostics', async () => {
  const root = await fixture();
  const git = new SkillRepositoryGit(root, new AbortController().signal, [], testFilesystemMetadata);
  await expect(git.run(['--version'], 2)).rejects.toThrow('output budget');
  await expect(git.run(['missing-glyph-test-subcommand'])).rejects.toThrow('missing-glyph-test-subcommand');
});

it('evaluates conditional includes against the initialized bare store before using any repository transport', async () => {
  const root = await fixture();
  const included = join(root, 'conditional.config');
  await writeFile(included, '[user]\nname = Conditional trusted identity\n');
  await writeFile(join(root, 'trusted.config'), '[includeIf "gitdir:**/source.git"]\npath = conditional.config\n');
  const git = new SkillRepositoryGit(root, new AbortController().signal, [], testFilesystemMetadata);
  await git.initialize('https://example.invalid/selected.git');
  expect((await git.run(['--git-dir=source.git', 'config', '--get', 'user.name'])).toString()).toBe(
    'Conditional trusted identity\n',
  );
  await writeFile(included, '[user]\nname = Later changed value\n');
  expect((await git.run(['--git-dir=source.git', 'config', '--get', 'user.name'])).toString()).toBe(
    'Conditional trusted identity\n',
  );
});

it('freezes URL-selected settings after recording the remote and before using transport', async () => {
  const root = await fixture();
  const included = join(root, 'company.config');
  await writeFile(included, '[user]\nname = Selected remote identity\n');
  await writeFile(
    join(root, 'trusted.config'),
    '[includeIf "hasconfig:remote.*.url:https://example.invalid/**"]\npath = company.config\n',
  );
  const git = new SkillRepositoryGit(root, new AbortController().signal, [], testFilesystemMetadata);
  await git.initialize('https://example.invalid/selected.git');
  expect((await git.run(['--git-dir=source.git', 'config', '--get-all', 'remote.origin.url'])).toString()).toBe(
    'https://example.invalid/selected.git\n',
  );
  const name = () => git.run(['--git-dir=source.git', 'config', '--get', 'user.name']);
  expect((await name()).toString().trim()).toBe('Selected remote identity');
  await writeFile(included, '[user]\nname = Changed after capture\n');
  expect((await name()).toString().trim()).toBe('Selected remote identity');
});
