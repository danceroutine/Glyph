import { chmod, readFile, writeFile, mkdir, rename, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { SkillPackageManager } from '../SkillPackageManager.ts';
import { SkillPackageDraft } from '../SkillPackageDraft.ts';
import { SkillStateStore } from '../SkillStateStore.ts';
import { SkillTransactionJournal } from '../SkillTransactionJournal.ts';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { aSkillDraft, aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';

it('binds equal-size binary updates, owner permissions and the physical target to each review', async () => {
  const { root, store, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const original = aSkillDraft().toJSON();
  await chmod(join(root, 'skills/example/assets/image.bin'), 0o600);
  const replacement = new SkillPackageDraft({
    ...original,
    files: original.files.map(file =>
      file.path === 'assets/image.bin'
        ? { ...file, content: Buffer.from([0, 3, 255]).toString('base64'), mode: 0o755 }
        : file,
    ),
  });
  const preview = await manager.prepare(skill.origin.id, replacement, skill.id);
  expect(preview.destination).toEqual({
    label: 'User',
    scope: 'user',
    path: await store.resolvePath('skills/example'),
  });
  const binary = preview.files.find(file => file.path.endsWith('.bin'))!;
  expect(binary).toMatchObject({
    status: 'modified',
    beforeInfo: { encoding: 'binary', size: 3, mode: 0o600 },
    afterInfo: { encoding: 'binary', size: 3, mode: 0o700 },
  });
  expect(binary.beforeInfo?.digest).not.toBe(binary.afterInfo?.digest);
  await chmod(join(root, 'skills/example/assets/image.bin'), 0o640);
  await expect(manager.apply(preview.id)).rejects.toThrow('changed after preview');
  await chmod(join(root, 'skills/example/assets/image.bin'), 0o600);
  const exact = await manager.prepare(skill.origin.id, replacement, skill.id);
  await manager.apply(exact.id);
  expect((await stat(join(root, 'skills/example/assets/image.bin'))).mode & 0o777).toBe(0o700);
  const state = new SkillStateStore(store);
  await state.initialize();
  expect(state.installations.get(skill.id)?.revision).toBe(exact.revision);
});
it('preserves the physical spelling on a case-folded comparison store', async () => {
  const { root } = await aSkillLifecycle();
  await mkdir(join(root, 'Some Folder'));
  const store = new FileSystemWorkspaceTextStore(root, { caseSensitive: false });
  expect(await store.resolvePath('Some Folder/New File')).toBe(join(root, 'Some Folder', 'New File'));
  expect(await store.canonicalPath('Some Folder/New File')).toBe(join(root, 'Some Folder', 'New File').toLowerCase());
});
it('rejects prefix collisions, deep resources and non-activatable manifests before creating an approval', () => {
  const input = aSkillDraft().toJSON();
  for (const paths of [
    ['lib', 'Lib/task'],
    ['a/b', 'a'],
    ['A/b', 'a/c'],
    [Array.from({ length: 35 }, () => 'x').join('/')],
  ]) {
    expect(
      () =>
        new SkillPackageDraft({
          ...input,
          files: [...input.files, ...paths.map(path => ({ path, content: 'text', encoding: 'utf8' }))],
        }),
    ).toThrow();
  }
  for (const body of ['a'.repeat(64 * 1024 + 1), 'a'.repeat(256 * 1024), 'a\0b']) {
    expect(() => aSkillDraft(body)).toThrow();
  }
});
it('preserves installed files when a fresh working-copy check sees an unsaved edit after staging', async () => {
  const { root, location, catalog, state, install } = await aSkillLifecycle();
  const skill = await install();
  const assertClean = vi.fn(async (_path: string) => {});
  const manager = new SkillPackageManager([{ ...location, assertClean }], catalog, state);
  const preview = await manager.prepare(skill.origin.id, aSkillDraft('Updated'), skill.id);
  assertClean.mockRejectedValueOnce(new Error('Save unsaved working copies'));
  await expect(manager.apply(preview.id)).rejects.toThrow('Save unsaved');
  expect(await readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Reviewed instructions');
  expect(manager.hasPreview(preview.id)).toBe(false);
});
it('restores the original when a process stopped between moving the old package and publishing its replacement', async () => {
  const { root, store, location, catalog, state, install } = await aSkillLifecycle();
  const skill = await install();
  const id = randomUUID();
  const stage = join(root, '.skill-staging', id);
  const directory = 'skills/example';
  const expected = state.installations.get(skill.id)!.revision;
  await mkdir(stage, { mode: 0o700 });
  const journal = new SkillTransactionJournal(root);
  await journal.write({
    id,
    root: await store.resolvePath('skills'),
    location: location.id,
    directory,
    skillId: skill.id,
    expected,
    replacement: aSkillDraft('new').revision,
    source: 'New source',
    published: false,
    retired: false,
  });
  await rename(join(root, directory), join(stage, 'previous'));
  await new SkillPackageManager([location], catalog, state).recover();
  expect(await readFile(join(root, directory, 'SKILL.md'), 'utf8')).toContain('Reviewed instructions');
  expect(state.installations.get(skill.id)?.revision).toBe(expected);
});
it('rejects stale removals when an indexed directory has vanished', async () => {
  const { root, location, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const listed = await location.listFiles();
  vi.spyOn(location, 'listFiles').mockResolvedValue(listed);
  await rm(join(root, 'skills/example'), { recursive: true });
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('missing');
});
it('fails closed on malformed preferences, accepts repairs, and only publishes acknowledged writes', async () => {
  const { root, store, state } = await aSkillLifecycle();
  await state.setEnabled('one', false);
  const actual = store.replace.bind(store);
  let release!: () => void;
  const hold = new Promise<void>(accept => {
    release = accept;
  });
  let confirm!: () => void;
  const started = new Promise<void>(resolve => {
    confirm = resolve;
  });
  vi.spyOn(store, 'replace').mockImplementationOnce(async (...args) => {
    confirm();
    await hold;
    return actual(...args);
  });
  const write = state.setEnabled('one', true);
  await started;
  expect(state.enabled.get('one')).toBe(false);
  release();
  await write;
  expect(state.enabled.get('one')).toBe(true);
  await writeFile(join(root, 'skill-state.json'), '{');
  await expect(state.initialize()).rejects.toThrow();
  await expect(state.setEnabled('new', true)).rejects.toThrow();
  expect(state.enabled.has('new')).toBe(false);
  await writeFile(join(root, 'skill-state.json'), JSON.stringify({ enabled: { one: false }, installations: {} }));
  await state.initialize();
  expect(state.enabled.get('one')).toBe(false);
});
