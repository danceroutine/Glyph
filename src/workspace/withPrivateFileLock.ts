import type { FilesystemMetadata } from './FilesystemMetadata.ts';
import { inspectPrivateDatabase, inspectPrivateDirectory } from './privateStorageMetadata.ts';
import Database from 'better-sqlite3';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';

/** Serialize cooperating host processes. SQLite releases the writer lock when a process exits. */
export async function withPrivateFileLock<T>(
  metadata: FilesystemMetadata,
  path: string,
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await inspectPrivateDirectory(metadata, directory);
  for (const suffix of ['-journal', '-shm', '-wal'])
    if (await optionalStat(path + suffix)) throw new Error('Invalid lock sidecar.');
  await inspectPrivateDatabase(metadata, path, 'lock');
  const db = new Database(path, { timeout: 0 });
  try {
    const deadline = Date.now() + 30000;
    for (;;) {
      signal?.throwIfAborted();
      try {
        db.exec('PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE');
        break;
      } catch (error) {
        if (errorCodeOf(error) !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error;
        await setTimeout(20, undefined, { signal });
      }
    }
    return await work();
  } finally {
    db.close();
  }
}

function optionalStat(name: string) {
  return lstat(name).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
}
