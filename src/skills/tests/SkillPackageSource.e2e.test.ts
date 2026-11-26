import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SkillPackageSourceReader } from '#src/skills/SkillPackageSource.js';

const manifest = '---\nname: example\ndescription: Example workflow\n---\nPinned instructions';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glyph-skill-source-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'example');
  await mkdir(directory);
  await writeFile(join(directory, 'SKILL.md'), manifest);
  const reader = new SkillPackageSourceReader(resolve('target/release/glyph-context-index'));
  return { root, directory, reader };
}
describe(SkillPackageSourceReader, () => {
  it('uses the Rust index for selected local packages and preserves binary resource bytes', async () => {
    const { directory, reader } = await fixture();
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'assets/data'), Buffer.from([0, 255]));
    const draft = await reader.read({ kind: 'local', path: directory });
    expect(draft.files().get('assets/data')).toEqual(Uint8Array.from([0, 255]));
    expect(draft.files().get('SKILL.md')).toEqual(Uint8Array.from(Buffer.from(manifest)));
    expect(draft.source).toBe(directory);
  });
  it('rejects symlinked source directories and missing manifests', async () => {
    const { root, directory, reader } = await fixture();
    await symlink(directory, join(root, 'linked'));
    await expect(reader.read({ kind: 'local', path: join(root, 'linked') })).rejects.toThrow('symlink');
    await rm(join(directory, 'SKILL.md'));
    await writeFile(join(directory, 'notes.md'), 'Missing manifest');
    await expect(reader.read({ kind: 'local', path: directory })).rejects.toThrow('missing SKILL.md');
  });
  it('reads a selected repository commit without checkout and rejects symlinks and unsafe directories', async () => {
    const { root, directory, reader } = await fixture();
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('add', 'example');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'original');
    const revision = git('rev-parse', 'HEAD');
    await writeFile(join(directory, 'SKILL.md'), manifest.replace('Pinned', 'Newer'));
    git('add', 'example');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'updated');
    const config = join(root, 'fixture-git-config');
    await writeFile(config, `[url "file://${root}/"]\n  insteadOf = https://skills.invalid/package.git\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const source = {
      kind: 'repository' as const,
      url: 'https://skills.invalid/package.git',
      revision,
      directory: 'example',
    };
    const draft = await reader.read(source);
    expect(Buffer.from(draft.files().get('SKILL.md')!).toString()).toContain('Pinned instructions');
    expect(draft.source).toContain(revision);
    await expect(reader.read({ ...source, directory: '../escape' })).rejects.toThrow('relative');
    await expect(reader.read({ ...source, revision: '--invalid' })).rejects.toThrow();
    expect((await reader.read({ ...source, directory: 'example/' }, new AbortController().signal)).name).toBe(
      'example',
    );
    for (const invalidDirectory of ['/absolute', 'bad\\path', 'bad:tree'])
      await expect(reader.read({ ...source, directory: invalidDirectory })).rejects.toThrow('relative');
    await writeFile(join(root, 'SKILL.md'), manifest.replace('name: example', 'name: package'));
    git('add', 'SKILL.md');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'root package');
    expect((await reader.read({ ...source, revision: 'main', directory: '' })).name).toBe('package');
    for (let i = 0; i < 9; i++) await writeFile(join(directory, `large-${i}.bin`), Buffer.alloc(1024 * 1024, 1));
    git('add', 'example');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'large package');
    await expect(reader.read({ ...source, revision: 'main' })).rejects.toThrow('8 MiB');
    for (let i = 0; i < 9; i++) await rm(join(directory, `large-${i}.bin`));
    for (let i = 0; i < 258; i++) await writeFile(join(directory, `small-${i}.txt`), 'Resource');
    git('add', '-A', 'example');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'many resources');
    await expect(reader.read({ ...source, revision: 'main' })).rejects.toThrow('256 files');
    for (let i = 0; i < 258; i++) await rm(join(directory, `small-${i}.txt`));
    await symlink('SKILL.md', join(directory, 'link'));
    git('add', 'example');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'symlink');
    await expect(reader.read({ ...source, revision: 'main' })).rejects.toThrow('symlinks');
  });
});

it('reconciles a selected package after resources change and bounds discovery to 257 files', async () => {
  const { root, directory, reader } = await fixture();
  const { FileSystemWorkspaceTextStore } = await import('#src/workspace/FileSystemWorkspaceTextStore.js');
  const { listSkillPackageFiles } = await import('#src/skills/listSkillPackageFiles.js');
  const store = new FileSystemWorkspaceTextStore(root);
  const binary = resolve('target/release/glyph-context-index');
  const signal = new AbortController().signal;
  expect((await listSkillPackageFiles(store, 'example', binary, false, signal)).files).toEqual(['example/SKILL.md']);
  await writeFile(join(directory, 'new-resource.txt'), 'New resource');
  expect((await listSkillPackageFiles(store, 'example', binary, true)).files).toContain('example/new-resource.txt');
  expect((await reader.read({ kind: 'local', path: directory }, signal)).files().has('new-resource.txt')).toBe(true);
  for (let i = 0; i < 258; i++) await writeFile(join(directory, `file-${i}.txt`), 'Small resource');
  expect((await listSkillPackageFiles(store, 'example', binary, false)).truncated).toBe(true);
  await expect(reader.read({ kind: 'local', path: directory })).rejects.toThrow('file budget');
});

it('rejects packages exceeding the aggregate byte budget before returning a preview', async () => {
  const { directory, reader } = await fixture();
  for (let i = 0; i < 9; i++) await writeFile(join(directory, `file-${i}.bin`), Buffer.alloc(1024 * 1024, 1));
  await expect(reader.read({ kind: 'local', path: directory })).rejects.toThrow('8 MiB');
});

it('rejects repository URLs that would persist credentials in provenance', async () => {
  const { reader } = await fixture();
  for (const url of [
    'https://token@skills.invalid/repo.git',
    'https://skills.invalid/repo.git?token=secret',
    'https://skills.invalid/repo.git#secret',
    'https://user:password@skills.invalid/repo.git',
  ])
    await expect(reader.read({ kind: 'repository', url, revision: 'main', directory: 'example' })).rejects.toThrow(
      'without embedded credentials',
    );
});

it('rejects a partial local import when native indexing omits a symlink or policy-excluded resource', async () => {
  const { directory, reader } = await fixture();
  await symlink('SKILL.md', join(directory, 'helper'));
  await expect(reader.read({ kind: 'local', path: directory })).rejects.toThrow('symlinks');
  await rm(join(directory, 'helper'));
  await mkdir(join(directory, '.git'));
  await writeFile(join(directory, '.git', 'config'), 'excluded metadata');
  await expect(reader.read({ kind: 'local', path: directory })).rejects.toThrow('excluded');
});
it('captures executable permissions from local and Git source packages', async () => {
  const { root, directory, reader } = await fixture();
  await writeFile(join(directory, 'helper'), 'fixture', { mode: 0o700 });
  expect((await reader.read({ kind: 'local', path: directory })).packageFiles().get('helper')?.mode).toBe(0o700);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root });
  git('init', '-b', 'main');
  git('add', 'example');
  git('-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const config = join(root, 'test-config');
  await writeFile(config, '[url "file://' + root + '/"]\n  insteadOf = https://skills.invalid/source.git\n');
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const captured = await reader.read({
    kind: 'repository',
    revision: 'main',
    directory: 'example',
    url: 'https://skills.invalid/source.git',
  });
  expect(captured.packageFiles().get('helper')?.mode).toBe(0o755);
});
