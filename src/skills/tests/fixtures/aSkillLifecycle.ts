import { fixtureWorkspace } from '#src/workspace/tests/fixtures/workspaceAccess.js';
import { inventoryPackage, readDirectoryModes } from '#src/skills/skillPackageInventory.js';
import type { PinnedSourceAuthority } from '#src/workspace/PinnedSourceAuthority.js';
import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceDirectoryMutations } from '#src/workspace/WorkspaceDirectoryMutations.js';
import { testPackageMutations } from './testPackageMutations.ts';
import { onTestFinished, vi } from 'vitest';
import { FileSkillDiscoveryProvider } from '#src/skills/FileSkillDiscoveryProvider.js';
import { SkillPackageDraft } from '#src/skills/SkillPackageDraft.js';
import { SkillPackageManager } from '#src/skills/SkillPackageManager.js';
import { SkillStateStore } from '#src/skills/SkillStateStore.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';

export function aSkillDraft(body = 'Reviewed instructions', name = 'example') {
  return new SkillPackageDraft({
    name,
    source: 'Local fixture',
    files: [
      {
        path: 'SKILL.md',
        content: `---\nname: ${name}\ndescription: Fixture workflow\n---\n${body}`,
        encoding: 'utf8',
      },
      { path: 'references/notes.md', content: 'Pinned notes', encoding: 'utf8' },
      { path: 'assets/image.bin', content: Buffer.from([0, 255, 3]).toString('base64'), encoding: 'base64' },
    ],
  });
}
export async function aSkillLifecycle(
  openMutations: (
    root: string,
  ) => WorkspaceDirectoryMutations | Promise<WorkspaceDirectoryMutations> = testPackageMutations,
  metadata: FilesystemMetadata = testFilesystemMetadata,
  authority?: PinnedSourceAuthority,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-skill-manager-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const store = fixtureWorkspace(root);
  const state = new SkillStateStore(store.root, metadata);
  await state.initialize();
  const listFiles = () => store.list(10000, 'skills/**/*');
  const refreshIndex = vi.fn(async () => {});
  const listPackageDirectories = async (directory: string) => {
    const { directories } = await inventoryPackage(join(root, directory));
    return readDirectoryModes(directories, path => store.resolvePath(directory + '/' + path));
  };
  const provider = new FileSkillDiscoveryProvider({
    origin: { id: 'user:glyph', label: 'User', scope: 'user', compatibility: 'glyph' },
    directory: 'skills',
    ...(authority ? { authority } : {}),
    workspace: store,
    binaryStore: store,
    captureFiles: async directory => ({ ...(await listFiles()), directories: await listPackageDirectories(directory) }),
    listFiles,
    refreshIndex,
    uriForPath: path => `file://${root}/${path}`,
  });
  const catalog = new SkillCatalog([provider], state.enabled, state.installations);
  const location = {
    id: provider.id,
    scope: 'user' as const,
    label: 'User',
    store,
    workspace: store,
    mutations: await openMutations(root),
    listPackageDirectories,
    directory: 'skills',
    listFiles,
    refreshIndex,
  };
  const manager = new SkillPackageManager([location], catalog, state);
  const install = async () => {
    const preview = await manager.prepare(provider.id, aSkillDraft());
    await manager.apply(preview.id);
    return catalog.skills[0]!;
  };
  return { root, store, state, catalog, location, manager, provider, install };
}
