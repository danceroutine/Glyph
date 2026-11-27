import { fixtureWorkspace } from '#src/workspace/tests/fixtures/workspaceAccess.js';
import { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';
import { SkillPackageSourceReader } from '../SkillPackageSource.ts';
import { testSkillSource, testPackageIndex } from '#src/skills/tests/fixtures/skillPackageTestSource.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';
import { NativeWorkspaceMutations } from '#src/workspace/NativeWorkspaceMutations.js';
import { listSkillPackageFiles } from '#src/skills/listSkillPackageFiles.js';
import { FileSkillDiscoveryProvider } from '#src/skills/FileSkillDiscoveryProvider.js';
import { execFileSync } from 'node:child_process';
import { realpath, chmod, lstat, mkdir, mkdtemp, rm, writeFile, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const manifest = '---\nname: example\ndescription: Example workflow\n---\nPinned instructions';
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-skill-source-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  const config = join(home, 'git.config');
  await writeFile(config, '');
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', undefined);
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const directory = join(root, 'example');
  await mkdir(directory);
  await writeFile(join(directory, 'SKILL.md'), manifest);
  const reader = testSkillSource(
    resolve('target/release/glyph-context-index'),
    [],
    new NativeFilesystemMetadata(resolve('target/release/glyph-context-index')),
    new WorkspaceAccessPolicy(),
  );
  return { root, directory, reader };
}
describe(SkillPackageSourceReader, () => {
  it('rejects a real non-UTF-8 Git tree and accepts the repaired root package through a trailing-slash URL', async () => {
    const { root, reader } = await fixture();
    const repository = join(root, 'source.git');
    const git = (args: string[], input?: Buffer) =>
      execFileSync(
        'git',
        ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
        { cwd: root, ...(input ? { input } : {}) },
      );
    git(['init', '--bare', repository]);
    const object = (bytes: Buffer) =>
      git(['--git-dir=' + repository, 'hash-object', '-w', '--stdin'], bytes)
        .toString()
        .trim();
    const manifestId = object(Buffer.from(manifest));
    const assetId = object(Buffer.from([0xa5]));
    const tree = (path: Buffer) =>
      git(
        ['--git-dir=' + repository, 'mktree', '-z'],
        Buffer.concat([
          Buffer.from(`100644 blob ${manifestId}\tSKILL.md\0`),
          Buffer.from(`100644 blob ${assetId}\t`),
          path,
          Buffer.from('\0'),
        ]),
      )
        .toString()
        .trim();
    const commit = (path: Buffer) =>
      git(['--git-dir=' + repository, 'commit-tree', tree(path), '-m', 'fixture'])
        .toString()
        .trim();
    const source = { kind: 'repository' as const, url: 'https://skills.invalid/example.git/', directory: '' };
    await writeFile(
      process.env.GIT_CONFIG_GLOBAL!,
      `[url "file://${repository}"]\ninsteadOf = https://skills.invalid/example.git\n`,
    );
    await expect(reader.read({ ...source, revision: commit(Buffer.from([0x61, 0xff])) })).rejects.toThrow(
      'valid UTF-8',
    );
    const draft = await reader.read({ ...source, revision: commit(Buffer.from('asset.bin')) });
    expect(draft.name).toBe('example');
    expect(draft.files().get('asset.bin')).toEqual(Uint8Array.from([0xa5]));
  });
  it.each([false, true])('rejects a renamed local source after preview with replacement %s', async replace => {
    const { directory, reader } = await fixture();
    const draft = await reader.read({ kind: 'local', path: directory });
    const { manager, location, store } = await aSkillLifecycle();
    const preview = await manager.prepare(location.id, draft);
    await rename(directory, directory + '-moved');
    if (replace) {
      await mkdir(directory);
      await writeFile(join(directory, 'SKILL.md'), manifest);
    }
    await expect(manager.apply(preview.id)).rejects.toThrow(/source.*(moved|changed)/iu);
    expect(await store.exists('skills/example')).toBe(false);
    expect(manager.hasPreview(preview.id)).toBe(false);
  });
  it('uses the Rust index for selected local packages and preserves binary resource bytes', async () => {
    const { directory, reader } = await fixture();
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'assets/data'), Buffer.from([0, 255]));
    const draft = await reader.read({ kind: 'local', path: directory });
    expect(draft.files().get('assets/data')).toEqual(Uint8Array.from([0, 255]));
    expect(draft.files().get('SKILL.md')).toEqual(Uint8Array.from(Buffer.from(manifest)));
    expect(draft.source).toBe(directory);
  });
  it('imports a stored manifest alias under its portable name and keeps physically distinct resources', async () => {
    const { directory, reader } = await fixture();
    const standard = join(directory, 'SKILL.md');
    const alias = join(directory, 'ſkill.md');
    await rename(standard, alias);
    const stored = await lstat(alias);
    const canonical = await lstat(standard).catch(() => undefined);
    const sameManifest = canonical?.ino === stored.ino && canonical.dev === stored.dev;
    if (!sameManifest) {
      await expect(reader.read({ kind: 'local', path: directory })).rejects.toThrow('missing SKILL.md');
      await writeFile(standard, manifest, { flag: 'wx' });
      await writeFile(alias, 'Independent resource');
    }
    const draft = await reader.read({ kind: 'local', path: directory });
    expect(draft.files().get('SKILL.md')).toEqual(Uint8Array.from(Buffer.from(manifest)));
    if (sameManifest) expect([...draft.files().keys()]).toEqual(['SKILL.md']);
    else expect(draft.files().get('ſkill.md')).toEqual(Uint8Array.from(Buffer.from('Independent resource')));
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
  const store = fixtureWorkspace(root);
  const binary = resolve('target/release/glyph-context-index');
  const signal = new AbortController().signal;
  expect((await listSkillPackageFiles(store, 'example', testPackageIndex(binary), false, signal)).files).toEqual([
    'example/SKILL.md',
  ]);
  await writeFile(join(directory, 'new-resource.txt'), 'New resource');
  expect((await listSkillPackageFiles(store, 'example', testPackageIndex(binary), true)).files).toContain(
    'example/new-resource.txt',
  );
  expect((await reader.read({ kind: 'local', path: directory }, signal)).files().has('new-resource.txt')).toBe(true);
  for (let i = 0; i < 258; i++) await writeFile(join(directory, `file-${i}.txt`), 'Small resource');
  expect((await listSkillPackageFiles(store, 'example', testPackageIndex(binary), false)).truncated).toBe(true);
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

it('retains empty template branches through local import, exact native publication, activation and an unchanged update', async () => {
  const { directory, reader } = await fixture();
  await mkdir(join(directory, 'templates/skeleton/empty'), { recursive: true });
  await chmod(join(directory, 'templates/skeleton/empty'), 0o750);
  await chmod(join(directory, 'templates'), 0o751);
  await writeFile(join(directory, 'templates/readme'), 'Instructions');
  const { manager, catalog, location, store } = await aSkillLifecycle(root =>
    NativeWorkspaceMutations.open(resolve('target/release/glyph-workspace-mutations'), root),
  );
  const draft = await reader.read({ kind: 'local', path: directory });
  expect(draft.packageDirectories().get('templates/skeleton/empty')).toBe(0o750);
  expect(draft.packageDirectories().get('templates')).toBe(0o751);
  const preview = await manager.prepare(location.id, draft);
  expect(preview.directories).toContainEqual({ path: 'templates/skeleton/empty', status: 'added', afterMode: 0o750 });
  await rm(directory, { recursive: true });
  await manager.apply(preview.id);
  const skill = catalog.skills[0]!;
  const installed = await store.resolvePath(skill.directory);
  const reimport = await reader.read({ kind: 'local', path: installed });
  const update = await manager.prepare(location.id, reimport, skill.id);
  expect(update.directories?.every(entry => entry.status === 'unchanged')).toBe(true);
  expect(update.revision).toBe(preview.revision);
  await manager.apply(update.id);
  expect((await lstat(join(installed, 'templates/skeleton/empty'))).mode & 0o777).toBe(0o750);
  expect((await lstat(join(installed, 'templates'))).mode & 0o777).toBe(0o751);
  const scoped = new FileSkillDiscoveryProvider({
    origin: skill.origin,
    directory: location.directory,
    workspace: store,
    binaryStore: store,
    listFiles: location.listFiles,
    uriForPath: path => path,
    refreshIndex: location.refreshIndex,
    captureFiles: (packagePath, signal) =>
      listSkillPackageFiles(
        store,
        packagePath,
        testPackageIndex(resolve('target/release/glyph-context-index')),
        false,
        signal,
      ),
  });
  const pinned = await scoped.capture(skill);
  expect(pinned.revision).toBe(update.revision);
  expect(pinned.packageDirectories()).toEqual(reimport.packageDirectories());
  const removal = await manager.prepareRemoval(skill.id);
  expect(removal.directories).toContainEqual({
    path: 'templates/skeleton/empty',
    status: 'removed',
    beforeMode: 0o750,
  });
  await mkdir(join(installed, 'templates/skeleton/empty/new'));
  await expect(manager.apply(removal.id)).rejects.toThrow('changed after preview');
  expect((await lstat(join(installed, 'templates/skeleton/empty/new'))).isDirectory()).toBe(true);
});
