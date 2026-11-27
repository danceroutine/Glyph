import { withPrivateFileLock } from '#src/workspace/withPrivateFileLock.js';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Separate SQLite connections acquire a process-owned lock that the OS releases on exit. */
export async function withSkillLock<T>(
  root: string,
  name: 'destination' | 'preferences',
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const staging = await privateSkillDirectory(root);
  return withPrivateFileLock(join(staging, name + '.sqlite'), work, signal);
}

export async function privateSkillDirectory(root: string): Promise<string> {
  const path = join(await realpath(root), '.skill-staging');
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill staging requires a private directory.');
  if (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()))
    throw new Error('Skill staging must belong to the current user and have permissions 0700: ' + path);
  const ignore = join(path, '.gitignore');
  if (!(await optionalStat(ignore))) {
    // Publish a complete marker before creating locks, journals, or package backups.
    const temporary = join(path, randomUUID() + '.ignore');
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile('*\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, ignore).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      await syncDirectory(path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const handle = await open(ignore, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== 2 || (await handle.read(Buffer.alloc(2))).buffer.toString('utf8') !== '*\n')
      throw new Error('Skill staging requires a .gitignore that excludes all entries.');
  } finally {
    await handle.close();
  }
  return path;
}

export async function optionalStat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
