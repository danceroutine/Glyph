import { SkillStateStore } from '#src/skills/SkillStateStore.js';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SkillPackageManager } from '#src/skills/SkillPackageManager.js';
import { aSkillDraft, aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';

describe(SkillPackageManager, () => {
  it('previews complete packages without writes, installs exact bytes, and retains source/version metadata', async () => {
    const { root, manager, catalog, provider } = await aSkillLifecycle();
    const draft = aSkillDraft();
    const preview = await manager.prepare(provider.id, draft);
    expect(preview.action).toBe('install');
    expect(preview.files.map(file => file.path)).toContain('SKILL.md');
    await expect(readFile(join(root, 'skills/example/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await manager.apply(preview.id);
    expect(await readFile(join(root, 'skills/example/assets/image.bin'))).toEqual(Buffer.from([0, 255, 3]));
    expect(catalog.skills[0]).toMatchObject({
      name: 'example',
      installedFrom: 'Local fixture',
      packageRevision: draft.revision,
    });
    await expect(manager.apply(preview.id)).rejects.toThrow('expired');
  });
  it('persists enablement independently of package contents and restores it after reload', async () => {
    const { store, state, catalog, manager, install } = await aSkillLifecycle();
    const skill = await install();
    await manager.setEnabled(skill.id, false);
    expect(catalog.skills[0]?.enabled).toBe(false);
    const restored = new SkillStateStore(store);
    await restored.initialize();
    expect(restored.enabled.get(skill.id)).toBe(false);
    expect(restored.installations.get(skill.id)?.revision).toBe(state.installations.get(skill.id)?.revision);
    await manager.setEnabled(skill.id, true);
    expect(catalog.skills[0]?.enabled).toBe(true);
    await expect(manager.setEnabled('missing', false)).rejects.toThrow('unavailable');
  });
  it('updates and removes only the approved package, and discards denied previews', async () => {
    const { root, manager, catalog, install } = await aSkillLifecycle();
    const skill = await install();
    const other = await manager.prepare(skill.origin.id, aSkillDraft('Other', 'other'));
    await manager.apply(other.id);
    const update = await manager.prepare(skill.origin.id, aSkillDraft('Updated'), skill.id);
    expect(update.files.find(file => file.path === 'SKILL.md')?.before).toContain('Reviewed instructions');
    manager.discard(update.id);
    await expect(manager.apply(update.id)).rejects.toThrow('expired');
    expect(await readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Reviewed instructions');
    const accepted = await manager.prepare(skill.origin.id, aSkillDraft('Updated'), skill.id);
    await manager.apply(accepted.id);
    expect(await readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Updated');
    const removal = await manager.prepareRemoval(skill.id);
    await manager.apply(removal.id);
    expect(catalog.skills.map(item => item.name)).toEqual(['other']);
    expect(await readFile(join(root, 'skills/other/SKILL.md'), 'utf8')).toContain('Other');
  });
  it('rejects collisions, stale previews, wrong targets, and symlinked resources', async () => {
    const { root, manager, install } = await aSkillLifecycle();
    const skill = await install();
    await expect(manager.prepare(skill.origin.id, aSkillDraft())).rejects.toThrow('already occupies');
    await expect(manager.prepare('unknown', aSkillDraft())).rejects.toThrow('cannot be managed');
    await expect(manager.prepare(skill.origin.id, aSkillDraft('Other', 'other'), skill.id)).rejects.toThrow(
      'selected installed',
    );
    await expect(manager.prepareRemoval('missing')).rejects.toThrow('unavailable');
    const preview = await manager.prepare(skill.origin.id, aSkillDraft('Update'), skill.id);
    await writeFile(join(root, 'skills/example/references/notes.md'), 'User edit');
    await expect(manager.apply(preview.id)).rejects.toThrow('changed after preview');
    expect(await readFile(join(root, 'skills/example/references/notes.md'), 'utf8')).toBe('User edit');
    await symlink(join(root, 'skill-state.json'), join(root, 'skills/example/link.md'));
    await expect(manager.prepareRemoval(skill.id)).rejects.toThrow();
  });
  it('restores an installed package if recording the update fails', async () => {
    const { root, state, manager, install } = await aSkillLifecycle();
    const skill = await install();
    const preview = await manager.prepare(skill.origin.id, aSkillDraft('Uncommitted'), skill.id);
    vi.spyOn(state, 'record').mockRejectedValueOnce(new Error('Disk full'));
    await expect(manager.apply(preview.id)).rejects.toThrow('Disk full');
    expect(await readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Reviewed instructions');
  });
  it('cancels before writes and refuses an occupied empty directory', async () => {
    const { root, manager, provider } = await aSkillLifecycle();
    const preview = await manager.prepare(provider.id, aSkillDraft());
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    await expect(manager.apply(preview.id, controller.signal)).rejects.toThrow('Cancelled');
    await mkdir(join(root, 'skills/example'), { recursive: true });
    await expect(manager.prepare(provider.id, aSkillDraft())).rejects.toThrow('already occupies');
  });
});

it('bounds preview retention and exposes installation targets without exposing package bytes', async () => {
  const { manager, provider } = await aSkillLifecycle();
  expect(manager.targets).toEqual([
    expect.objectContaining({ id: provider.id, label: 'User', uri: expect.stringMatching(/skills$/u) }),
  ]);
  const previews = [];
  for (let i = 0; i < 33; i++) previews.push(await manager.prepare(provider.id, aSkillDraft()));
  await expect(manager.apply(previews[0]!.id)).rejects.toThrow('expired');
  await manager.apply(previews.at(-1)!.id);
});

it('refuses package replacement while an editor contains unsaved changes', async () => {
  const { store, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const original = store.read.bind(store);
  vi.spyOn(store, 'read').mockImplementation(async (path, options) => ({
    ...(await original(path, options)),
    revision: 'unsaved-revision',
  }));
  await expect(manager.prepare(skill.origin.id, aSkillDraft('Replacement'), skill.id)).rejects.toThrow(
    'Save skill edits',
  );
});

it('rejects incomplete discovery, unindexed package files, and missing installed packages', async () => {
  const { root, store, manager, install } = await aSkillLifecycle();
  const skill = await install();
  vi.spyOn(store, 'list').mockResolvedValueOnce({ files: [], truncated: true });
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('incomplete');
  vi.mocked(store.list).mockResolvedValueOnce({ files: [], truncated: false });
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('unindexed');
  const { rm } = await import('node:fs/promises');
  await rm(join(root, 'skills/example'), { recursive: true });
  await expect(manager.prepare(skill.origin.id, aSkillDraft('Replacement'), skill.id)).rejects.toThrow('missing');
});

it('rejects oversized installed packages before replacing them', async () => {
  const { root, manager, install } = await aSkillLifecycle();
  const skill = await install();
  for (let i = 0; i < 9; i++) await writeFile(join(root, `skills/example/large-${i}.txt`), 'x'.repeat(1024 * 1024));
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('8 MiB');
});

it('rejects oversized inventories and deep package trees', async () => {
  const { root, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const deep = join(root, 'skills/example', ...Array.from({ length: 34 }, () => 'nested'));
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'file.txt'), 'Deep file');
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('nesting');
  const { rm } = await import('node:fs/promises');
  await rm(join(root, 'skills/example/nested'), { recursive: true });
  for (let i = 0; i < 257; i++) await writeFile(join(root, `skills/example/file-${i}.txt`), 'File');
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('256 files');
});

it('enforces the managed directory boundary even for a misconfigured provider', async () => {
  const { catalog, provider, manager, install } = await aSkillLifecycle();
  const skill = await install();
  for (const directory of ['other/example', 'skills/./example']) {
    vi.spyOn(provider, 'discover').mockResolvedValueOnce([{ ...skill, directory }]);
    await catalog.refresh();
    await expect(manager.prepareRemoval(skill.id)).rejects.toThrow();
  }
});
