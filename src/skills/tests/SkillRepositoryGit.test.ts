import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, vi, onTestFinished } from 'vitest';
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
