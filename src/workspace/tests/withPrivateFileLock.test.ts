import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withPrivateFileLock } from '#src/workspace/withPrivateFileLock.js';

let path: string, root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'glyph-private-lock-'));
  path = join(root, 'locks', 'coordination.sqlite');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('waits for an independent process and acquires the lock after that process exits', async () => {
  await mkdir(dirname(path), { mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import Database from 'better-sqlite3';
    const db = new Database(process.argv[1]);
    db.exec('PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE');
    process.send('held');
    process.on('message', () => process.exit(0));
  `,
      path,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  const exit = once(child, 'exit');
  try {
    expect(await once(child, 'message')).toEqual(['held', undefined]);
    const work = vi.fn(async () => 42);
    const held = await new Promise<boolean>((resolve, reject) => {
      const signal = AbortSignal.timeout(120);
      withPrivateFileLock(path, work, signal).then(
        () => {
          resolve(false);
        },
        error => {
          if (signal.aborted) resolve(true);
          else reject(error);
        },
      );
    });
    expect(held).toBe(true);
    expect(work).not.toHaveBeenCalled();
    child.send('exit');
    await exit;
    await expect(withPrivateFileLock(path, work)).resolves.toBe(42);
  } finally {
    if (child.exitCode === null) child.kill();
    await exit;
  }
});

it('rejects foreign, shared, redirected and forged private lock storage', async () => {
  await symlink(root, dirname(path));
  await expect(withPrivateFileLock(path, async () => {})).rejects.toThrow('private');
  await rm(dirname(path));
  await mkdir(dirname(path), { mode: 0o700 });
  await chmod(dirname(path), 0o755);
  await expect(withPrivateFileLock(path, async () => {})).rejects.toThrow('private');
  await chmod(dirname(path), 0o700);
  const owner = vi.spyOn(process, 'getuid').mockReturnValue(-1);
  await expect(withPrivateFileLock(path, async () => {})).rejects.toThrow('private');
  owner.mockRestore();
  await mkdir(path);
  await expect(withPrivateFileLock(path, async () => {})).rejects.toThrow('Invalid lock file');
  await rm(path, { recursive: true });
  await writeFile(path, '');
  await link(path, join(root, 'alias'));
  await expect(withPrivateFileLock(path, async () => {})).rejects.toThrow('Invalid lock file');
  await rm(join(root, 'alias'));
  await writeFile(path, 'content');
  await expect(withPrivateFileLock(path, async () => {})).rejects.toThrow('Invalid lock file');
  await rm(path);
  await writeFile(path + '-journal', '');
  await expect(withPrivateFileLock(path, async () => {})).rejects.toThrow('sidecar');
});

it('rejects outstanding locks at their deadline and propagates filesystem errors', async () => {
  await mkdir(dirname(path), { mode: 0o700 });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE');
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(30001);
  try {
    await expect(withPrivateFileLock(path, async () => {})).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
  } finally {
    clock.mockRestore();
    db.close();
  }
  await expect(withPrivateFileLock(join(dirname(path), 'a'.repeat(300)), async () => {})).rejects.toMatchObject({
    code: 'ENAMETOOLONG',
  });
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try {
    await expect(withPrivateFileLock(path, async () => true)).resolves.toBe(true);
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
