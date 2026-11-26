import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceDirectoryMutations } from '#src/workspace/WorkspaceDirectoryMutations.js';
import { testPackageMutations } from './testPackageMutations.ts';
import { onTestFinished, vi } from 'vitest';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
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
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-skill-manager-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const store = new FileSystemWorkspaceTextStore(root);
  const state = new SkillStateStore(store);
  await state.initialize();
  const listFiles = () => store.list(10000, 'skills/**/*');
  const refreshIndex = vi.fn(async () => {});
  const provider = new FileSkillDiscoveryProvider({
    origin: { id: 'user:glyph', label: 'User', scope: 'user', compatibility: 'glyph' },
    directory: 'skills',
    workspace: store,
    binaryStore: store,
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
