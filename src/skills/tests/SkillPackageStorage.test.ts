import Database from 'better-sqlite3';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, onTestFinished, vi } from 'vitest';
import { privateSkillDirectory, syncDirectory, withSkillLock } from '#src/skills/SkillPackageStorage.js';
import { inventoryFiles, readPackageFiles } from '#src/skills/skillPackageInventory.js';
import { SkillTransactionJournal } from '#src/skills/SkillTransactionJournal.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glyph-skill-protected-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
it('rejects links, foreign owners and permissive pre-existing storage before package recovery', async () => {
  const root = await fixture(),
    staging = join(root, '.skill-staging');
  await symlink(root, staging);
  await expect(privateSkillDirectory(root)).rejects.toThrow('private directory');
  await rm(staging);
  await mkdir(staging, { mode: 0o700 });
  await chmod(staging, 0o755);
  await expect(privateSkillDirectory(root)).rejects.toThrow('0700');
  await chmod(staging, 0o700);
  const uid = vi.spyOn(process, 'getuid').mockReturnValue(-1);
  await expect(privateSkillDirectory(root)).rejects.toThrow('current user');
  uid.mockRestore();
  await writeFile(join(root, 'file'), 'occupied');
  await expect(privateSkillDirectory(join(root, 'file'))).rejects.toThrow();
});
it('rejects fake and linked lock or journal files and unexpected SQLite sidecars', async () => {
  const root = await fixture(),
    staging = await privateSkillDirectory(root);
  const lock = join(staging, 'destination.sqlite');
  const using = () => withSkillLock(root, 'destination', async () => {});
  await writeFile(lock, 'other contents');
  await expect(using()).rejects.toThrow('Invalid lock file');
  await rm(lock);
  await mkdir(lock);
  await expect(using()).rejects.toThrow('Invalid lock file');
  await rm(lock, { recursive: true });
  const other = join(root, 'empty');
  await writeFile(other, '');
  await link(other, lock);
  await expect(using()).rejects.toThrow('Invalid lock file');
  await rm(lock);
  await writeFile(lock + '-wal', '');
  await expect(using()).rejects.toThrow('sidecar');
  const journal = new SkillTransactionJournal(root);
  const file = join(staging, 'journal.sqlite');
  await link(other, file);
  await expect(journal.entries(root, 'scope')).rejects.toThrow('Invalid skill transaction journal');
  await rm(file);
  await mkdir(file);
  await expect(journal.entries(root, 'scope')).rejects.toThrow('Invalid skill transaction journal');
});
it('fails a timed-out competing process lock and releases its own connection', async () => {
  const root = await fixture(),
    staging = await privateSkillDirectory(root);
  const db = new Database(join(staging, 'destination.sqlite'));
  db.exec('PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE');
  const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(30001);
  try {
    await expect(withSkillLock(root, 'destination', async () => {})).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
  } finally {
    now.mockRestore();
    db.close();
  }
  await expect(withSkillLock(root, 'destination', async () => 42)).resolves.toBe(42);
});
it('skips POSIX mode and directory fsync checks on Windows', async () => {
  const root = await fixture(),
    staging = await privateSkillDirectory(root);
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try {
    expect(await privateSkillDirectory(root)).toBe(staging);
    await expect(syncDirectory(join(root, 'absent'))).resolves.toBeUndefined();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
it('bounds moved-package bytes and treats a missing physical package as absent', async () => {
  const root = await fixture();
  expect(await inventoryFiles(join(root, 'absent'))).toEqual([]);
  const files = Array.from({ length: 9 }, (_, i) => String(i));
  await Promise.all(files.map(path => writeFile(join(root, path), Buffer.alloc(1024 * 1024))));
  await expect(readPackageFiles(root, files)).rejects.toThrow('8 MiB');
});
