import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FilesystemMetadata } from './FilesystemMetadata.ts';

export async function inspectPrivateDirectory(metadata: FilesystemMetadata, path: string): Promise<void> {
  const error = 'A private directory must belong to the current user and have permissions 0700.';
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(cause => {
    throw new Error(error, { cause });
  });
  try {
    const stat = await handle.stat();
    if (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700))
      throw new Error(error);
    await metadata.inspect(handle, 'access');
  } finally {
    await handle.close();
  }
}

/** The parent is owner-controlled. Create SQLite's ordinary file with closed permissions before opening the database. */
export async function inspectPrivateDatabase(
  metadata: FilesystemMetadata,
  path: string,
  role: 'lock' | 'journal' | 'sidecar',
): Promise<void> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(path, flags).catch((error: NodeJS.ErrnoException) => {
    if (role === 'sidecar' || error.code !== 'ENOENT') throw error;
    return open(path, flags | constants.O_CREAT, 0o600);
  });
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (role === 'lock' && stat.size > 0) ||
      (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0))
    )
      throw new Error(role === 'lock' ? 'Invalid lock file.' : 'Invalid skill transaction journal.');
    await metadata.inspect(handle, role === 'sidecar' ? 'replaceable' : 'access');
    // Existing SQLite databases created by earlier versions may have inherited a more permissive umask.
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) await handle.chmod(stat.mode & 0o700);
  } finally {
    await handle.close();
  }
}
