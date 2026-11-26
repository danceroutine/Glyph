import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceDirectoryMutations } from '#src/workspace/WorkspaceDirectoryMutations.js';
import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';

/** Local fault-injection double. Integration tests exercise the actual descriptor-relative helper. */
export function testPackageMutations(root: string): WorkspaceDirectoryMutations {
  return {
    async ensureDirectory(relative) {
      await mkdir(join(root, relative), { recursive: true, mode: 0o700 });
    },
    async renameExclusive(sourceRelative, targetRelative) {
      const target = join(root, targetRelative);
      try {
        await lstat(target);
      } catch (error) {
        if (errorCodeOf(error) !== 'ENOENT') throw error;
        return rename(join(root, sourceRelative), target);
      }
      throw Object.assign(new Error('Destination exists.'), { code: 'EEXIST' });
    },
    removeTree: relative => rm(join(root, relative), { force: true, recursive: true }),
  };
}
