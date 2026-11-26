import { chmod, readFile, writeFile, mkdir, rename, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { it, expect, vi } from 'vitest';
import { SkillPackageManager } from '#src/skills/SkillPackageManager.js';
import { SkillPackageDraft } from '#src/skills/SkillPackageDraft.js';
import { SkillStateStore } from '#src/skills/SkillStateStore.js';
import { SkillTransactionJournal } from '#src/skills/SkillTransactionJournal.js';
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

it('blocks discovery, capture, management and stale approvals while preferences are unreadable, then retries after repair', async () => {
  const { root, state, location, provider, install } = await aSkillLifecycle();
  const installed = await install();
  const { SkillCatalog } = await import('#src/skills/SkillCatalog.js');
  const ready = async () => state.initialize();
  const catalog = new SkillCatalog([provider], state.enabled, state.installations, ready);
  const manager = new SkillPackageManager([location], catalog, state, ready);
  await catalog.refresh();
  const change = await manager.prepare(location.id, aSkillDraft('New workflow', 'another'));
  const preferencePath = join(root, 'skill-state.json');
  const previous = await readFile(preferencePath, 'utf8');
  await writeFile(preferencePath, '{invalid-json');
  const discover = vi.spyOn(provider, 'discover');
  expect(await catalog.refresh()).toMatchObject([{ enabled: false, path: '' }]);
  expect(discover).not.toHaveBeenCalled();
  await expect(catalog.capture(installed)).rejects.toThrow();
  await expect(manager.prepare(location.id, aSkillDraft())).rejects.toThrow();
  await expect(manager.prepareRemoval(installed.id)).rejects.toThrow();
  await expect(manager.setEnabled(installed.id, true)).rejects.toThrow();
  await expect(manager.apply(change.id)).rejects.toThrow();
  expect(manager.hasPreview(change.id)).toBe(false);
  await writeFile(preferencePath, previous);
  expect(await catalog.refresh()).toMatchObject([{ id: installed.id, enabled: true }]);
  expect((await catalog.capture(installed)).descriptor.id).toBe(installed.id);
  await manager.setEnabled(installed.id, false);
  await expect(catalog.capture(installed)).rejects.toThrow('disabled');
  expect((await manager.prepareRemoval(installed.id)).action).toBe('remove');
});

it('recovers only authenticated committed publications and preserves changed assets or missing backups', async () => {
  const { root, store, location, state, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const revision = state.installations.get(skill.id)!.revision;
  const journal = new SkillTransactionJournal(root);
  const id = randomUUID(),
    stage = join(root, '.skill-staging', id);
  const record = {
    id,
    root: await store.resolvePath('skills'),
    location: location.id,
    directory: skill.directory,
    skillId: skill.id,
    expected: null,
    replacement: revision,
    source: 'Approved import',
    published: true,
    retired: false,
  };
  await mkdir(stage, { mode: 0o700 });
  await journal.write({ ...record, replacement: 'changed' });
  await expect(manager.recover()).rejects.toThrow('Published files changed');
  await journal.write({ ...record, expected: revision });
  await expect(manager.recover()).rejects.toThrow('Inspect retained staging');
  await journal.write(record);
  await manager.recover();
  expect(state.installations.get(skill.id)?.source).toBe('Approved import');
  await mkdir(stage, { mode: 0o700 });
  await writeFile(join(stage, 'retired'), 'completed');
  await journal.write({ ...record, retired: true });
  await manager.recover();
  await expect(stat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('preserves uncertain originals and distinguishes independent identical packages from a published candidate', async () => {
  const { root, store, location, state, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const revision = state.installations.get(skill.id)!.revision;
  const journal = new SkillTransactionJournal(root);
  const id = randomUUID(),
    stage = join(root, '.skill-staging', id);
  const record = {
    id,
    root: await store.resolvePath('skills'),
    location: location.id,
    directory: skill.directory,
    skillId: skill.id,
    expected: null,
    replacement: revision,
    source: 'Approved import',
    published: false,
    retired: false,
  };
  await mkdir(stage, { mode: 0o700 });
  await journal.write({ ...record, expected: 'unrecognized' });
  await expect(manager.recover()).rejects.toThrow('Inspect the changed original');
  await mkdir(join(stage, 'package'));
  await mkdir(join(stage, 'previous'));
  await journal.write({ ...record, expected: 'old' });
  await expect(manager.recover()).rejects.toThrow('Preserved backups');
  await rm(join(stage, 'previous'), { recursive: true });
  await journal.write(record);
  await manager.recover();
  expect(await readFile(join(root, skill.path), 'utf8')).toContain('Reviewed instructions');
});
it('blocks changed physical destinations and failed journal writes before touching a package', async () => {
  const { root, store, location, manager } = await aSkillLifecycle();
  const draft = aSkillDraft();
  const auth = store.resolvePath.bind(store);
  const preview = await manager.prepare(location.id, draft);
  const guard = vi
    .spyOn(store, 'resolvePath')
    .mockImplementation(path => (path === 'skills/example' ? Promise.resolve(join(root, 'other')) : auth(path)));
  await expect(manager.apply(preview.id)).rejects.toThrow('destination changed');
  guard.mockRestore();
  const other = await manager.prepare(location.id, draft);
  const journal = vi
    .spyOn(SkillTransactionJournal.prototype, 'write')
    .mockRejectedValueOnce(new Error('Journal unavailable'));
  await expect(manager.apply(other.id)).rejects.toThrow('Journal unavailable');
  journal.mockRestore();
  await expect(stat(join(root, '.skill-staging', other.id))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('preserves the journal on uncertainty or post-commit changes, and refuses stale enablement', async () => {
  const { root, store, location, catalog, state, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const plain = new SkillPackageManager([], catalog, state);
  await plain.setEnabled(skill.id, false);
  const draft = aSkillDraft('Update');
  const change = await manager.prepare(location.id, draft, skill.id);
  const save = state.record.bind(state);
  const record = vi.spyOn(state, 'record').mockImplementationOnce(async (...args) => {
    await save(...args);
    await writeFile(join(root, skill.path), 'Human edits after the commit');
  });
  await expect(manager.apply(change.id)).rejects.toThrow('Published files changed');
  record.mockRestore();
  await expect(manager.recover()).rejects.toThrow('Published files changed');
  const separate = new SkillPackageManager([location], catalog, new SkillStateStore(store));
  await rm(join(root, skill.directory), { recursive: true });
  const journal = new SkillTransactionJournal(root);
  await journal.finish(change.id);
  await expect(separate.setEnabled(skill.id, true)).rejects.toThrow('missing');
});
it('reconciles failed preference acknowledgements and reports unreadable or undurable outcomes', async () => {
  const { state, store, root } = await aSkillLifecycle();
  await state.setEnabled('one', true);
  const replace = store.replace.bind(store);
  vi.spyOn(store, 'replace').mockImplementationOnce(async (...args) => {
    await replace(...args);
    throw new Error('Lost acknowledgement');
  });
  await state.setEnabled('one', false);
  expect(state.enabled.get('one')).toBe(false);
  vi.spyOn(store, 'replace').mockImplementationOnce(async () => {
    vi.spyOn(store, 'readOptional').mockRejectedValueOnce(new Error('Unreadable'));
    throw new Error('Uncertain write');
  });
  await expect(state.setEnabled('one', true)).rejects.toThrow('needs recovery');
  vi.spyOn(store, 'resolvePath').mockResolvedValueOnce(join(root, 'missing-after-commit'));
  await expect(state.setEnabled('one', true)).rejects.toThrow('needs recovery');
  expect(state.enabled.get('one')).toBe(false);
});
it('round trips imported executable mode and compares non-UTF8 files without a NUL', async () => {
  const { manager, location } = await aSkillLifecycle();
  const input = aSkillDraft().toJSON();
  const imported = new SkillPackageDraft({
    ...input,
    files: [...input.files, { path: 'resource', mode: 0o700, content: '/w==', encoding: 'base64' }],
  });
  expect(new SkillPackageDraft(imported.toJSON()).revision).toBe(imported.revision);
  const preview = await manager.prepare(location.id, imported);
  expect(preview.files.find(file => file.path === 'resource')?.afterInfo).toMatchObject({
    encoding: 'binary',
    mode: 0o700,
  });
});

it('rechecks an empty journal and rolls back an unrecordable first installation', async () => {
  const { root, location, state, manager } = await aSkillLifecycle();
  await manager.recover();
  vi.spyOn(state, 'record').mockRejectedValueOnce(new Error('Storage full'));
  const change = await manager.prepare(location.id, aSkillDraft());
  await expect(manager.apply(change.id)).rejects.toThrow('Storage full');
  await expect(stat(join(root, 'skills/example'))).rejects.toMatchObject({ code: 'ENOENT' });
  await manager.recover();
});
