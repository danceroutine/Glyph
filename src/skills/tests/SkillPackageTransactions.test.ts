import { testFilesystemMetadata } from '#src/workspace/tests/fixtures/testFilesystemMetadata.js';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aSkillDraft, aSkillLifecycle } from './fixtures/aSkillLifecycle.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    link: vi.fn(actual.link),
    mkdir: vi.fn(actual.mkdir),
    lstat: vi.fn(actual.lstat),
    opendir: vi.fn(actual.opendir),
  };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
afterEach(() => {
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.link).mockImplementation(actual.link);
  vi.mocked(fs.mkdir).mockImplementation(actual.mkdir);
  vi.mocked(fs.lstat).mockImplementation(actual.lstat);
  vi.mocked(fs.opendir).mockImplementation(actual.opendir);
});
describe('Skill package transactions', () => {
  it('bounds the transaction inventory even when discovery excludes excess files', async () => {
    const { root, store, manager, install } = await aSkillLifecycle();
    const skill = await install();
    const listing = await store.list(10000, 'skills/**/*');
    vi.spyOn(store, 'list').mockResolvedValue(listing);
    await Promise.all(
      Array.from({ length: 254 }, (_, index) =>
        actual.writeFile(join(root, 'skills/example', `excluded-${index}`), 'Unindexed'),
      ),
    );
    await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('256 files');
    expect(await actual.readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Reviewed instructions');
  });
  it('restores a removed package when forgetting its persisted state fails', async () => {
    const { root, manager, state, install } = await aSkillLifecycle();
    const skill = await install();
    const preview = await manager.prepareRemoval(skill.id);
    vi.spyOn(state, 'forget').mockRejectedValueOnce(new Error('State write failed'));
    await expect(manager.apply(preview.id)).rejects.toThrow('State write failed');
    expect(await fs.readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Reviewed instructions');
  });
  it('retains the original when its first rename fails without moving files', async () => {
    const { root, manager, install } = await aSkillLifecycle();
    const skill = await install();
    const preview = await manager.prepareRemoval(skill.id);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('Permission denied'));
    await expect(manager.apply(preview.id)).rejects.toThrow('Permission denied');
    expect(await fs.readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Reviewed instructions');
  });
  it('treats a directory disappearing between stat and inventory as missing', async () => {
    const { manager, provider } = await aSkillLifecycle();
    vi.mocked(fs.opendir).mockImplementation((path, options) => {
      if (String(path).endsWith('/skills/example'))
        return Promise.reject(Object.assign(new Error('Removed directory'), { code: 'ENOENT' }));
      return actual.opendir(path, options);
    });
    expect((await manager.prepare(provider.id, aSkillDraft())).action).toBe('install');
  });
  it('retains a concurrent edit discovered after moving the original package', async () => {
    const { root, manager, install } = await aSkillLifecycle();
    const skill = await install();
    const preview = await manager.prepare(skill.origin.id, aSkillDraft('Update'), skill.id);
    vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
      await actual.rename(source, destination);
      await actual.writeFile(join(String(destination), 'references/notes.md'), 'Concurrent edit');
    });
    await expect(manager.apply(preview.id)).rejects.toThrow('changed during replacement');
    expect(await fs.readFile(join(root, 'skills/example/references/notes.md'), 'utf8')).toBe('Concurrent edit');
  });
  it('keeps backups when a concurrent destination prevents automatic restoration', async () => {
    const { root, manager, install } = await aSkillLifecycle();
    const skill = await install();
    const preview = await manager.prepare(skill.origin.id, aSkillDraft('Update'), skill.id);
    vi.mocked(fs.rename).mockImplementationOnce(async (source, destination) => {
      await actual.rename(source, destination);
      await actual.mkdir(String(source));
      await actual.writeFile(join(String(source), 'user.txt'), 'New destination');
      throw new Error('Interrupted replacement');
    });
    await expect(manager.apply(preview.id)).rejects.toThrow('recovery is required');
    expect(await fs.readFile(join(root, 'skills/example/user.txt'), 'utf8')).toBe('New destination');
    const backups = (await fs.readdir(join(root, '.skill-staging'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(join(root, '.skill-staging', backups[0]!, 'previous/SKILL.md'), 'utf8')).toContain(
      'Reviewed instructions',
    );
  });
  it('preserves both package versions if files change during persistence rollback', async () => {
    const { root, state, manager, install } = await aSkillLifecycle();
    const skill = await install();
    const preview = await manager.prepare(skill.origin.id, aSkillDraft('Update'), skill.id);
    vi.spyOn(state, 'record').mockImplementationOnce(async () => {
      await actual.writeFile(join(root, 'skills/example/user.txt'), 'Concurrent change');
      throw new Error('State store failed');
    });
    await expect(manager.apply(preview.id)).rejects.toThrow('Preserved backups');
    expect(await fs.readFile(join(root, 'skills/example/user.txt'), 'utf8')).toBe('Concurrent change');
    expect(
      (await fs.readdir(join(root, '.skill-staging'), { withFileTypes: true })).filter(entry => entry.isDirectory()),
    ).toHaveLength(1);
  });
  it('reports committed changes separately from catalog delivery failures', async () => {
    const { root, catalog, manager, provider } = await aSkillLifecycle();
    const preview = await manager.prepare(provider.id, aSkillDraft());
    vi.spyOn(catalog, 'refresh').mockRejectedValueOnce(new Error('Catalog unavailable'));
    expect(await manager.apply(preview.id)).toMatchObject({
      applied: true,
      refreshError: expect.stringContaining('changed successfully'),
    });
    expect(await fs.readFile(join(root, 'skills/example/SKILL.md'), 'utf8')).toContain('Reviewed instructions');
  });
  it('rejects a destination created while staging and propagates occupancy inspection errors', async () => {
    const { root, manager, provider } = await aSkillLifecycle();
    const target = join(root, 'skills/example');
    const first = await manager.prepare(provider.id, aSkillDraft());
    vi.mocked(fs.mkdir).mockImplementation(async (path, options) => {
      if (String(path).includes('/.skill-staging/')) await actual.mkdir(target, { recursive: true });
      return actual.mkdir(path, options);
    });
    await expect(manager.apply(first.id)).rejects.toThrow();
    expect(await actual.readdir(target)).toEqual([]);
  });
});

it('fails closed when backup inspection fails after an uncertain rename', async () => {
  const { location, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const preview = await manager.prepare(skill.origin.id, aSkillDraft('Update'), skill.id);
  vi.spyOn(location.mutations, 'renameExclusive').mockRejectedValueOnce(new Error('Lost filesystem acknowledgement'));
  vi.mocked(fs.lstat).mockImplementation((path, options) => {
    if (String(path).endsWith('/previous'))
      return Promise.reject(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    return actual.lstat(path, options);
  });
  await expect(manager.apply(preview.id)).rejects.toThrow('Inspect retained staging');
});

it('does not hide filesystem errors when checking package occupancy', async () => {
  const { store, manager, provider } = await aSkillLifecycle();
  const target = await store.resolvePath('skills/example');
  const preview = await manager.prepare(provider.id, aSkillDraft());
  let staged = false;
  vi.mocked(fs.mkdir).mockImplementation(async (path, options) => {
    const result = await actual.mkdir(path, options);
    if (String(path).includes('/.skill-staging/')) staged = true;
    return result;
  });
  vi.mocked(fs.lstat).mockImplementation((path, options) => {
    if (staged && String(path) === target)
      return Promise.reject(Object.assign(new Error('Occupancy unavailable'), { code: 'EACCES' }));
    return actual.lstat(path, options);
  });
  await expect(manager.apply(preview.id)).rejects.toThrow('Occupancy unavailable');
});

it('refuses unreadable or non-directory packages without starting a replacement', async () => {
  const { root, manager, store, catalog, provider, install } = await aSkillLifecycle();
  const skill = await install();
  const listed = await store.list(10000, 'skills/**/*');
  vi.spyOn(store, 'list').mockResolvedValue(listed);
  vi.mocked(fs.opendir).mockImplementation((path, options) => {
    if (String(path) === join(root, 'skills/example'))
      return Promise.reject(Object.assign(new Error('Read denied'), { code: 'EACCES' }));
    return actual.opendir(path, options);
  });
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('Read denied');
  vi.mocked(fs.opendir).mockImplementation(actual.opendir);
  vi.mocked(fs.lstat).mockImplementation((path, options) => {
    if (String(path) === join(root, 'skills/example'))
      return Promise.reject(Object.assign(new Error('Stat denied'), { code: 'EACCES' }));
    return actual.lstat(path, options);
  });
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('Stat denied');
  vi.mocked(fs.lstat).mockImplementation(actual.lstat);
  await actual.writeFile(join(root, 'skills/not-a-directory'), 'Occupied');
  vi.spyOn(provider, 'discover').mockResolvedValueOnce([{ ...skill, directory: 'skills/not-a-directory' }]);
  await catalog.refresh();
  vi.mocked(store.list).mockResolvedValue({ files: [], truncated: false });
  await expect(manager.prepareRemoval(skill.id)).rejects.toThrow('real directory');
});

it('preserves the previous package and rejects provenance when published bytes differ from approval', async () => {
  const { manager, root, state, install } = await aSkillLifecycle();
  const skill = await install();
  const preview = await manager.prepare(skill.origin.id, aSkillDraft('Update'), skill.id);
  const record = vi.spyOn(state, 'record');
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    await actual.rename(from, to);
    if (String(from).endsWith('/package'))
      await actual.writeFile(join(String(to), 'references/notes.md'), 'External change');
  });
  await expect(manager.apply(preview.id)).rejects.toThrow('recovery is required');
  expect(record).not.toHaveBeenCalled();
  expect(await actual.readFile(join(root, 'skills/example/references/notes.md'), 'utf8')).toBe('External change');
  expect(await actual.readFile(join(root, '.skill-staging', preview.id, 'previous/references/notes.md'), 'utf8')).toBe(
    'Pinned notes',
  );
  await expect(manager.recover()).rejects.toThrow('recovery is required');
});

it('publishes a replacement preference through a temporary inside the protected profile directory', async () => {
  const { root, state, store } = await aSkillLifecycle();
  await state.setEnabled('user-skill', false, new AbortController().signal);
  const renamed: string[] = [];
  vi.mocked(fs.rename).mockImplementation(async (before, after) => {
    if (String(after) === join(root, 'skill-state.json')) renamed.push(String(before));
    await actual.rename(before, after);
  });
  await state.setEnabled('user-skill', true, new AbortController().signal);
  const latest = await store.read('skill-state.json');
  await expect(
    store.replace('skill-state.json', latest.revision, 'other', false, { temporaryDirectory: join(root, '..') }),
  ).rejects.toThrow('escapes');
  expect(renamed).toHaveLength(1);
  expect(renamed[0]).toMatch(/\/\.skill-staging\/\.[^/]+\.glyph\.tmp$/u);
});

it('propagates directory-mode inspection failures before moving the original', async () => {
  const { root, location, manager, install } = await aSkillLifecycle();
  const skill = await install();
  const { SkillPackageDraft } = await import('#src/skills/SkillPackageDraft.js');
  const input = aSkillDraft().toJSON();
  const update = await manager.prepare(
    location.id,
    new SkillPackageDraft({
      ...input,
      files: [...input.files, { path: 'new-branch/notes', encoding: 'utf8', content: 'Updated' }],
    }),
    skill.id,
  );
  vi.mocked(fs.lstat).mockImplementation((path, options) => {
    if (String(path) === join(root, skill.directory))
      return Promise.reject(Object.assign(new Error('Mode unavailable'), { code: 'EACCES' }));
    return actual.lstat(path, options);
  });
  const moves = vi.spyOn(location.mutations, 'renameExclusive');
  await expect(manager.apply(update.id)).rejects.toThrow('Mode unavailable');
  expect(moves).not.toHaveBeenCalled();
});

it('publishes the self-ignore marker exclusively and propagates a failed marker write before locking', async () => {
  const { root } = await aSkillLifecycle();
  const { privateSkillDirectory } = await import('#src/skills/SkillPackageStorage.js');
  const marker = join(root, '.skill-staging/.gitignore');
  await actual.rm(marker);
  vi.mocked(fs.link).mockImplementationOnce(async (from, to) => {
    await actual.link(from, to);
    throw Object.assign(new Error('Concurrent creator'), { code: 'EEXIST' });
  });
  await expect(privateSkillDirectory(testFilesystemMetadata, root)).resolves.toBe(join(root, '.skill-staging'));
  await actual.rm(marker);
  vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error('Disk full'), { code: 'ENOSPC' }));
  await expect(privateSkillDirectory(testFilesystemMetadata, root)).rejects.toThrow('Disk full');
  await expect(actual.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
