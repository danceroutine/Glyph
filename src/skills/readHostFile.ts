import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';

/**
 * Reads one physically selected host file through the same descriptor before and after inspection.
 * Callers authorize its absolute path for their operation (transaction digest, Git configuration or preferences)
 * and keep the resulting bytes inside that operation. This primitive grants no project or catalog access.
 */
export async function readHostFile(path: string, limit?: number, inspect?: (handle: FileHandle) => Promise<void>) {
  const physical = await realpath(path);
  for (let entry = path; entry !== dirname(entry); entry = dirname(entry)) {
    if ((await lstat(entry)).isSymbolicLink()) throw new Error('Host file access requires a physical path.');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const check = async () => {
      await inspect?.(handle);
      const stat = await handle.stat({ bigint: true });
      const entry = await lstat(path, { bigint: true });
      if (
        !stat.isFile() ||
        stat.nlink !== 1n ||
        stat.ino !== entry.ino ||
        stat.dev !== entry.dev ||
        (await realpath(path)) !== physical
      )
        throw new Error('The host file changed or has an unsupported link.');
      return stat;
    };
    const stat = await check();
    let bytes: Buffer;
    if (limit === undefined) bytes = await handle.readFile();
    else {
      const capacity = Number(stat.size);
      if (capacity > limit) throw new Error('Host file exceeds the read budget.');
      const buffer = Buffer.alloc(capacity + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size !== capacity) throw new Error('The host file changed during capture.');
      bytes = buffer.subarray(0, size);
    }
    await check();
    return {
      bytes,
      mode: Number(stat.mode & 0o7777n),
      uid: Number(stat.uid),
      gid: Number(stat.gid),
      dev: stat.dev,
      ino: stat.ino,
    };
  } finally {
    await handle.close();
  }
}
