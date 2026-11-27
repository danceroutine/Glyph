import { testSkillSource, testPackageIndex } from '#src/skills/tests/fixtures/skillPackageTestSource.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { FileSkillDiscoveryProvider } from '#src/skills/FileSkillDiscoveryProvider.js';
import { aSkillDescriptor } from './fixtures/aSkillDescriptor.ts';
import { listSkillPackageFiles } from '#src/skills/listSkillPackageFiles.js';
const native = vi.hoisted(() => ({
  refresh: vi.fn(async () => ({ truncated: false })),
  glob: vi.fn<() => Promise<{ files: string[]; truncated: boolean }>>(async () => ({ files: [], truncated: true })),
  listDirectories: vi.fn<() => Promise<string[]>>(async () => []),
  dispose: vi.fn(async () => {}),
}));
beforeEach(() => {
  native.refresh.mockReset().mockResolvedValue({ truncated: false });
  native.glob.mockReset().mockResolvedValue({ files: [], truncated: true });
  native.listDirectories.mockReset().mockResolvedValue([]);
  native.dispose.mockClear();
});
vi.mock('#src/context/search/RustWorkspacePathIndex.js', () => ({
  RustWorkspacePathIndex: class {
    refresh = native.refresh;
    glob = native.glob;
    listDirectories = native.listDirectories;
    dispose = native.dispose;
  },
}));
describe('Skill package inventory boundaries', () => {
  it('captures local package bytes only after reconciling its scoped native inventory', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'glyph-native-inventory-'));
    const root = join(temporary, 'example');
    await mkdir(root);
    onTestFinished(() => rm(temporary, { recursive: true, force: true }));
    await writeFile(join(root, 'SKILL.md'), '---\nname: example\ndescription: Fixture\n---\nInstructions');
    await mkdir(join(root, 'assets'));
    await mkdir(join(root, 'templates'));
    await writeFile(join(root, 'assets/image'), 'image');
    native.listDirectories.mockResolvedValueOnce(['assets', 'templates']);
    native.glob.mockResolvedValueOnce({ files: ['SKILL.md', 'assets/image'], truncated: false });
    const draft = await testSkillSource('native', [], testFilesystemMetadata, new WorkspaceAccessPolicy()).read(
      { kind: 'local', path: root },
      new AbortController().signal,
    );
    expect(draft.files().has('SKILL.md')).toBe(true);
    expect([...draft.packageDirectories().keys()]).toEqual(['assets', 'templates']);
    expect(native.refresh.mock.invocationCallOrder[0]).toBeLessThan(native.glob.mock.invocationCallOrder[0]!);
    expect(native.dispose).toHaveBeenCalledOnce();
    const linked = `${root}-link`;
    await symlink(root, linked);
    onTestFinished(() => rm(linked));
    await expect(
      testSkillSource('native', [], testFilesystemMetadata, new WorkspaceAccessPolicy()).read({
        kind: 'local',
        path: linked,
      }),
    ).rejects.toThrow('symlink');
  });
  it('checks a local resource against the host policy even when a stale index supplies its path', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'glyph-private-import-'));
    onTestFinished(() => rm(temporary, { recursive: true, force: true }));
    const root = join(temporary, 'example');
    await mkdir(root);
    await writeFile(join(root, 'SKILL.md'), '---\nname: example\ndescription: Fixture\n---\nExample');
    await writeFile(join(root, 'trace'), 'fixture');
    const policy = new WorkspaceAccessPolicy({}, [join(root, 'trace')]);
    const reader = testSkillSource('native', [], testFilesystemMetadata, policy, []);
    native.glob.mockResolvedValueOnce({ files: ['SKILL.md', 'trace'], truncated: false });
    await expect(reader.read({ kind: 'local', path: root })).rejects.toThrow('excluded');
  });

  it('rejects changes to private reservations during resource capture and after preview approval', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'glyph-source-generation-'));
    onTestFinished(() => rm(temporary, { recursive: true, force: true }));
    const root = join(temporary, 'example');
    await mkdir(root);
    await writeFile(join(root, 'SKILL.md'), '---\nname: example\ndescription: Fixture\n---\nExample');
    let paths: string[] = [];
    const policy = new WorkspaceAccessPolicy({}, () => paths);
    const reader = testSkillSource('native', [], testFilesystemMetadata, policy, []);
    const listing = { files: ['SKILL.md'], truncated: false };
    native.glob.mockImplementationOnce(async () => {
      paths = [join(root, 'future-private')];
      return listing;
    });
    await expect(reader.read({ kind: 'local', path: root })).rejects.toThrow('Host-private locations changed');
    native.glob.mockResolvedValue(listing);
    const draft = await reader.read({ kind: 'local', path: root });
    const { manager, location, store } = await aSkillLifecycle();
    const preview = await manager.prepare(location.id, draft);
    paths = [join(root, 'SKILL.md')];
    const signal = new AbortController().signal;
    await expect(manager.apply(preview.id, signal)).rejects.toThrow('Host-private locations changed');
    expect(await store.exists('skills/example')).toBe(false);

    paths = [];
    const admitted = await reader.read({ kind: 'local', path: root });
    const pending = await manager.prepare(location.id, admitted);
    const stage = location.mutations.stagePackage.bind(location.mutations);
    vi.spyOn(location.mutations, 'stagePackage').mockImplementationOnce(async (...args) => {
      await stage(...args);
      paths = [join(root, 'SKILL.md')];
    });
    await expect(manager.apply(pending.id)).rejects.toThrow('Host-private locations changed');
    expect(await store.exists('skills/example')).toBe(false);

    paths = [];
    const current = await reader.read({ kind: 'local', path: root });
    const allowed = await manager.prepare(location.id, current);
    await expect(manager.apply(allowed.id)).resolves.toMatchObject({ applied: true });
  });

  it('rechecks physical source intersections at publication even when the configured private paths stay fixed', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'glyph-import-intersection-'));
    onTestFinished(() => rm(temporary, { recursive: true, force: true }));
    const root = join(temporary, 'example');
    await mkdir(root);
    await writeFile(join(root, 'SKILL.md'), '---\nname: example\ndescription: Fixture\n---\nExample');
    const privatePaths = [join(temporary, 'credentials')];
    let intersects = false;
    const metadata = {
      ...testFilesystemMetadata,
      assertHostPaths: vi.fn(async () => {
        if (intersects) throw new Error('The source intersects a host-private object.');
      }),
    };
    native.glob.mockResolvedValue({ files: ['SKILL.md'], truncated: false });
    const reader = testSkillSource('native', [], metadata, new WorkspaceAccessPolicy({}, privatePaths), []);
    const draft = await reader.read({ kind: 'local', path: root });
    const { manager, location, store } = await aSkillLifecycle();
    const preview = await manager.prepare(location.id, draft);
    const stage = location.mutations.stagePackage.bind(location.mutations);
    vi.spyOn(location.mutations, 'stagePackage').mockImplementationOnce(async (...args) => {
      await stage(...args);
      intersects = true;
    });
    await expect(manager.apply(preview.id)).rejects.toThrow('intersects a host-private object');
    expect(metadata.assertHostPaths).toHaveBeenLastCalledWith([root], privatePaths);
    expect(await store.exists('skills/example')).toBe(false);
  });

  it('rejects a truncated local index before requesting file bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyph-skill-inventory-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    native.refresh.mockResolvedValueOnce({ truncated: true });
    await expect(
      testSkillSource('native', [], testFilesystemMetadata, new WorkspaceAccessPolicy()).read({
        kind: 'local',
        path: root,
      }),
    ).rejects.toThrow('file budget');
    expect(native.glob).not.toHaveBeenCalled();
    expect(native.dispose).toHaveBeenCalledOnce();
  });
  it('bounds total local package bytes before producing a preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyph-skill-inventory-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const files = Array.from({ length: 9 }, (_, i) => `file-${i}`);
    await Promise.all(files.map(path => writeFile(join(root, path), Buffer.alloc(1024 * 1024))));
    native.glob.mockResolvedValueOnce({ files, truncated: false });
    await expect(
      testSkillSource('native', [], testFilesystemMetadata, new WorkspaceAccessPolicy()).read({
        kind: 'local',
        path: root,
      }),
    ).rejects.toThrow('8 MiB');
    expect(native.dispose).toHaveBeenCalledOnce();
  });
  it('qualifies fresh native package paths and disposes the index on truncation and failure', async () => {
    const workspace = new FileSystemWorkspaceTextStore('/workspace');
    vi.spyOn(workspace, 'resolvePath').mockResolvedValue('/workspace/example');
    native.glob.mockResolvedValueOnce({ files: ['SKILL.md'], truncated: false });
    expect(
      await listSkillPackageFiles(
        workspace,
        'example',
        testPackageIndex('native'),
        false,
        new AbortController().signal,
      ),
    ).toEqual({
      files: ['example/SKILL.md'],
      directories: new Map(),
      truncated: false,
    });
    native.refresh.mockResolvedValueOnce({ truncated: true });
    expect(await listSkillPackageFiles(workspace, 'example', testPackageIndex('native'), true)).toEqual({
      files: [],
      directories: new Map(),
      truncated: true,
    });
    native.glob.mockResolvedValueOnce({ files: ['new-resource'], truncated: false });
    expect((await listSkillPackageFiles(workspace, 'example', testPackageIndex('native'), true)).files).toEqual([
      'example/new-resource',
    ]);
    native.refresh.mockRejectedValueOnce(new Error('Index unavailable'));
    await expect(listSkillPackageFiles(workspace, 'example', testPackageIndex('native'), true)).rejects.toThrow(
      'Index unavailable',
    );
    expect(native.dispose).toHaveBeenCalledTimes(4);
  });
  it('rejects an index that becomes truncated between reconciliation and the exact glob request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyph-skill-inventory-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const reader = testSkillSource('injected-native-index', [], testFilesystemMetadata, new WorkspaceAccessPolicy());
    await expect(reader.read({ kind: 'local', path: root })).rejects.toThrow('file budget');
    expect(native.dispose).toHaveBeenCalledOnce();
  });
  it('rejects truncated activation inventory before reading resource bodies', async () => {
    const workspace = new FileSystemWorkspaceTextStore('/not-read');
    const read = vi.spyOn(workspace, 'read');
    const provider = new FileSkillDiscoveryProvider({
      origin: aSkillDescriptor().origin,
      directory: '.glyph/skills',
      workspace,
      listFiles: async () => ({ files: [], truncated: false }),
      captureFiles: async () => ({ files: [], truncated: true }),
      uriForPath: path => path,
      refreshIndex: async () => {},
    });
    await expect(provider.capture(aSkillDescriptor())).rejects.toThrow('inventory is incomplete');
    expect(read).not.toHaveBeenCalled();
  });
});

it('rejects local packages when the physical inventory contains omitted files or different paths at the same count', async () => {
  const root = await mkdtemp(join(tmpdir(), 'glyph-incomplete-import-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'hidden'), 'contents');
  for (const files of [[], ['other']]) {
    native.refresh.mockResolvedValueOnce({ truncated: false });
    native.glob.mockResolvedValueOnce({ files, truncated: false });
    await expect(
      testSkillSource('native', [], testFilesystemMetadata, new WorkspaceAccessPolicy()).read({
        kind: 'local',
        path: root,
      }),
    ).rejects.toThrow('unindexed');
  }
});

it('refuses an excluded empty local directory and a native candidate that turned into a file', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'glyph-empty-source-'));
  const root = join(parent, 'example');
  await mkdir(join(root, 'hidden'), { recursive: true });
  onTestFinished(() => rm(parent, { recursive: true, force: true }));
  await writeFile(join(root, 'SKILL.md'), 'manifest');
  native.glob.mockResolvedValue({ files: ['SKILL.md'], truncated: false });
  const reader = testSkillSource('native', [], testFilesystemMetadata, new WorkspaceAccessPolicy());
  await expect(reader.read({ kind: 'local', path: root })).rejects.toThrow('unindexed');
  native.listDirectories.mockResolvedValueOnce(['SKILL.md']);
  await expect(reader.read({ kind: 'local', path: root })).rejects.toThrow('directory changed');
});
