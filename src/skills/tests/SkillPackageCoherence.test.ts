import { fixtureWorkspace } from '#src/workspace/tests/fixtures/workspaceAccess.js';
import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';
import { SkillPackageDraft } from '#src/skills/SkillPackageDraft.js';
import { SkillPackageManager } from '#src/skills/SkillPackageManager.js';
import { SkillTransactionJournal } from '#src/skills/SkillTransactionJournal.js';
import { privateSkillDirectory } from '#src/skills/SkillPackageStorage.js';
import { aSkillDraft, aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';

it('rejects a full package swap during capture even with an unchanged manifest', async () => {
  const { store, manager, catalog, install } = await aSkillLifecycle();
  const skill = await install();
  const input = aSkillDraft().toJSON();
  const update = await manager.prepare(
    skill.origin.id,
    new SkillPackageDraft({
      ...input,
      files: input.files.map(file =>
        file.path === 'references/notes.md' ? { ...file, encoding: 'utf8', content: 'Second revision' } : file,
      ),
    }),
    skill.id,
  );
  const read = store.read.bind(store);
  let changed = false;
  vi.spyOn(store, 'read').mockImplementation(async (path, options) => {
    const snapshot = await read(path, options);
    if (!changed && path === skill.path) {
      changed = true;
      await manager.apply(update.id);
    }
    return snapshot;
  });
  await expect(catalog.capture(skill)).rejects.toThrow('changed during capture');
  expect((await catalog.capture(skill)).inspectResource('references/notes.md').content).toBe('Second revision');
});

it('rejects a changing live editor revision and additions to the final capture inventory', async () => {
  const { root, store, catalog, install } = await aSkillLifecycle();
  const skill = await install();
  const read = store.read.bind(store);
  const note = 'skills/example/references/notes.md';
  let reads = 0;
  const spy = vi.spyOn(store, 'read').mockImplementation(async (path, options) => {
    const snapshot = await read(path, options);
    return path === note && ++reads === 1 ? { ...snapshot, revision: 'earlier-working-copy' } : snapshot;
  });
  await expect(catalog.capture(skill)).rejects.toThrow('changed during capture');
  spy.mockRestore();
  vi.spyOn(store, 'read').mockImplementation(async (path, options) => {
    const snapshot = await read(path, options);
    if (path === note) await writeFile(join(root, 'skills/example/assets/added.txt'), 'New resource');
    return snapshot;
  });
  await expect(catalog.capture(skill)).rejects.toThrow('changed during capture');
});

it('rolls back an ignored publication before persisting it, restoring the previously reviewed files', async () => {
  const { root, location, catalog, manager, state, install } = await aSkillLifecycle();
  const skill = await install();
  const input = aSkillDraft('Changed instructions').toJSON();
  const draft = new SkillPackageDraft({
    ...input,
    files: [...input.files, { path: 'ignored.txt', encoding: 'utf8', content: 'new' }],
  });
  const update = await manager.prepare(skill.origin.id, draft, skill.id);
  const list = location.listFiles;
  vi.spyOn(location, 'listFiles').mockImplementation(async () => {
    const listing = await list();
    return { ...listing, files: listing.files.filter(path => !path.endsWith('/ignored.txt')) };
  });
  await expect(manager.apply(update.id)).rejects.toThrow('unindexed');
  expect(await readFile(join(root, skill.path), 'utf8')).toContain('Reviewed instructions');
  expect(state.installations.get(skill.id)?.revision).toBe(skill.packageRevision);
  await expect(lstat(join(root, skill.directory, 'ignored.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  await catalog.refresh();
  expect(await manager.prepareRemoval(skill.id)).toMatchObject({ action: 'remove' });
});

it('validates final candidate bytes before moving an existing package', async () => {
  const { root, location, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const update = await manager.prepare(skill.origin.id, aSkillDraft('Update'), skill.id);
  const stage = location.mutations.stagePackage.bind(location.mutations);
  vi.spyOn(location.mutations, 'stagePackage').mockImplementationOnce(async (...args) => {
    await stage(...args);
    await writeFile(join(root, args[0], 'references/notes.md'), 'Different bytes');
  });
  const rename = vi.spyOn(location.mutations, 'renameExclusive');
  await expect(manager.apply(update.id)).rejects.toThrow('staged skill');
  expect(rename).not.toHaveBeenCalled();
  expect(await readFile(join(root, skill.path), 'utf8')).toContain('Reviewed instructions');
  const input = aSkillDraft('Updated').toJSON();
  const invalidMode = await manager.prepare(
    skill.origin.id,
    new SkillPackageDraft({
      ...input,
      files: [...input.files, { path: 'unreadable', mode: 0o200, encoding: 'utf8', content: 'unavailable' }],
    }),
    skill.id,
  );
  await expect(manager.apply(invalidMode.id)).rejects.toThrow('readable');
  expect(rename).not.toHaveBeenCalled();
});

it('preserves project directory permissions and uses ordinary project permissions for new directories', async () => {
  const { root, location, catalog, state } = await aSkillLifecycle();
  const manager = new SkillPackageManager([{ ...location, scope: 'project' }], catalog, state);
  const apply = async (draft: SkillPackageDraft, replaceId?: string) => {
    const preview = await manager.prepare(location.id, draft, replaceId);
    await manager.apply(preview.id);
  };
  await apply(aSkillDraft());
  const skill = catalog.skills[0]!;
  const modes = async (path: string) => (await lstat(join(root, path))).mode & 0o777;
  await mkdir(join(root, 'ordinary-directory'));
  expect(await modes('skills')).toBe(await modes('ordinary-directory'));
  expect(await modes(skill.directory)).toBe(await modes('skills'));
  await chmod(join(root, skill.directory), 0o750);
  await chmod(join(root, skill.directory, 'references'), 0o751);
  const input = aSkillDraft('Updated').toJSON();
  await apply(
    new SkillPackageDraft({
      ...input,
      files: [
        ...input.files.filter(file => file.path !== 'assets/image.bin'),
        { path: 'assets/image.bin/new/note', encoding: 'utf8', content: 'Branch' },
      ],
    }),
    skill.id,
  );
  expect(await modes(skill.directory)).toBe(0o750);
  expect(await modes(skill.directory + '/references')).toBe(0o751);
  expect(await modes(skill.directory + '/assets/image.bin/new')).toBe(await modes(skill.directory + '/assets'));
});

it('keeps an installed package usable and retries retired backup cleanup independently', async () => {
  const { root, location, catalog, state, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const update = await manager.prepare(location.id, aSkillDraft('Updated'), skill.id);
  const cleanup = vi.spyOn(location.mutations, 'removeTree').mockRejectedValue(new Error('Backup busy'));
  await expect(manager.apply(update.id)).resolves.toMatchObject({
    applied: true,
    refreshError: expect.stringContaining('cleanup'),
  });
  await expect(manager.recover(location.id)).resolves.toBeUndefined();
  expect((await catalog.capture(catalog.skills[0]!)).body).toBe('Updated');
  const journal = new SkillTransactionJournal(state.userDirectory, testFilesystemMetadata);
  expect(await journal.entries(join(root, 'skills'), location.id)).toMatchObject([{ retired: true }]);
  cleanup.mockRestore();
  await manager.recover();
  expect(await journal.entries(join(root, 'skills'), location.id)).toEqual([]);
});

it('reads idle project roots without creating private state and isolates provider recovery failures', async () => {
  const { root, location, catalog, state, provider, install } = await aSkillLifecycle();
  const skill = await install();
  const project = join(root, 'readonly-checkout');
  await mkdir(project, { mode: 0o555 });
  const other = { ...location, id: 'project:readonly', store: fixtureWorkspace(project) };
  const manager = new SkillPackageManager([location, other], catalog, state);
  await manager.recover(other.id);
  await expect(lstat(join(project, '.skill-staging'))).rejects.toMatchObject({ code: 'ENOENT' });
  const otherProvider = {
    id: other.id,
    origin: { ...provider.origin, id: other.id },
    discover: vi.fn(),
    capture: vi.fn(),
    refreshIndex: async () => {},
  };
  const scoped = new SkillCatalog(
    [provider, otherProvider],
    state.enabled,
    state.installations,
    undefined,
    async id => {
      if (id === other.id) throw new Error('Only this root needs recovery');
      await manager.recover(id);
    },
  );
  expect(await scoped.refresh()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: skill.id, status: 'active' }),
      expect.objectContaining({ message: 'Only this root needs recovery' }),
    ]),
  );
  expect(otherProvider.discover).not.toHaveBeenCalled();
  expect((await scoped.capture(skill)).revision).toBe(skill.packageRevision);
});

it('updates every subscribed catalog after a durable preference write and independently disposes subscriptions', async () => {
  const { provider, state, install } = await aSkillLifecycle();
  const skill = await install();
  state.onDidChange(() => {
    throw new Error('Disconnected window');
  });
  const other = new SkillCatalog(
    [provider],
    state.enabled,
    state.installations,
    undefined,
    undefined,
    state.onDidChange.bind(state),
  );
  await other.refresh();
  const changed = vi.fn();
  other.onDidChange(changed);
  await state.setEnabled(skill.id, false);
  await state.initialize();
  expect(other.skills[0]?.enabled).toBe(false);
  expect(changed).toHaveBeenCalledTimes(1);
  await state.forget(skill.id);
  expect(other.skills[0]?.enabled).toBe(true);
  expect(other.skills[0]?.installedFrom).toBeUndefined();
  other.dispose();
  new SkillCatalog([]).dispose();
  await state.setEnabled(skill.id, false);
  expect(other.skills[0]?.enabled).toBe(true);
});

it('keeps private locks and backups out of a normal Git add and validates the self-ignore marker', async () => {
  const { root } = await aSkillLifecycle();
  execFileSync('git', ['init', '-q', root]);
  const staging = await privateSkillDirectory(testFilesystemMetadata, root);
  await mkdir(join(staging, 'retired'));
  await writeFile(join(staging, 'retired', 'notes'), 'Private');
  expect(execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' })).toBe(
    '',
  );
  await writeFile(join(staging, '.gitignore'), '!\n');
  await expect(privateSkillDirectory(testFilesystemMetadata, root)).rejects.toThrow('.gitignore');
  await rm(join(staging, '.gitignore'));
  await mkdir(join(staging, '.gitignore'));
  await expect(privateSkillDirectory(testFilesystemMetadata, root)).rejects.toThrow('.gitignore');
});

it('rejects stale oversized index inventories before offering a removal', async () => {
  const { location, manager, install } = await aSkillLifecycle();
  const skill = await install();
  vi.spyOn(location, 'listFiles').mockResolvedValue({
    files: Array.from({ length: 257 }, (_, i) => skill.directory + '/' + i),
    truncated: false,
  });
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('exceeds 256 files');
});

it('reconciles an unfinished publication before accepting captured bytes and recognizes a concurrent disable', async () => {
  const { provider, catalog, state, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const prepared = await manager.prepare(provider.id, aSkillDraft('Replacement'), skill.id);
  const reconcile = vi
    .fn<() => Promise<void>>()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async () => {
      await manager.apply(prepared.id);
    });
  const guarded = new SkillCatalog([provider], state.enabled, state.installations, undefined, reconcile);
  await expect(guarded.capture(skill)).rejects.toThrow('skill changed');
  reconcile.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    await state.setEnabled(skill.id, false);
  });
  await expect(guarded.capture(catalog.skills[0]!)).rejects.toThrow('disabled during capture');
});

it('serializes a nested destination with its direct project root and preserves another origin’s unfinished publication', async () => {
  const { root, store, state, location } = await aSkillLifecycle();
  const inner = join(root, 'app');
  const directory = 'app/.glyph/skills/example';
  const physical = join(root, directory);
  await mkdir(physical, { recursive: true });
  await writeFile(join(physical, 'SKILL.md'), '---\nname: example\ndescription: Nested example\n---\nBody');
  const { ProjectSkillIdentity } = await import('#src/skills/ProjectSkillIdentity.js');
  const { FileSkillDiscoveryProvider } = await import('#src/skills/FileSkillDiscoveryProvider.js');
  const { withSkillLock } = await import('#src/skills/SkillPackageStorage.js');
  const { randomUUID } = await import('node:crypto');
  const identity = new ProjectSkillIdentity(root, '.glyph');
  const target = {
    ...location,
    id: identity.originId,
    scope: 'project' as const,
    directory: '.glyph/skills',
    packageId: (path: string) => identity.forDirectory(path),
    listFiles: () => store.list(10000, '**/.glyph/skills/**/*'),
  };
  const provider = new FileSkillDiscoveryProvider({
    ...target,
    origin: { id: target.id, scope: 'project', compatibility: 'glyph', label: 'Outer' },
    uriForPath: path => 'file://' + join(root, path),
  });
  const catalog = new SkillCatalog([provider]);
  const manager = new SkillPackageManager([target], catalog, state);
  const [skill] = await catalog.refresh();
  const preview = await manager.prepareRemoval(skill!.id);
  await withSkillLock(testFilesystemMetadata, inner, 'destination', async () => {
    await expect(manager.apply(preview.id, AbortSignal.timeout(150))).rejects.toThrow(/aborted|timeout/iu);
  });
  expect(await store.exists(directory + '/SKILL.md')).toBe(true);
  const journal = new SkillTransactionJournal(root, testFilesystemMetadata);
  const entry = {
    id: randomUUID(),
    root: join(inner, '.glyph/skills'),
    location: new ProjectSkillIdentity(inner, '.glyph').originId,
    directory: '.glyph/skills/example',
    skillId: skill!.id,
    expected: null,
    replacement: null,
    source: null,
    published: false,
    retired: false,
  };
  await journal.write(entry);
  await expect(manager.prepareRemoval(skill!.id)).rejects.toThrow('original project');
  await journal.write({ ...entry, retired: true });
  expect(await journal.hasOtherProjectTransaction(target.id, physical)).toBe(false);
  await journal.write({ ...entry, directory: '.glyph/skills/different' });
  expect(await journal.hasOtherProjectTransaction(target.id, physical)).toBe(false);
  await journal.finish(entry.id);
  const fresh = await manager.prepareRemoval(skill!.id);
  await expect(manager.apply(fresh.id)).resolves.toEqual({ applied: true });
  expect(await store.exists(directory + '/SKILL.md')).toBe(false);
});
