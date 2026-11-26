import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceDirectoryMutations } from '#src/workspace/WorkspaceDirectoryMutations.js';
import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';

/** Local fault-injection double. Integration tests exercise the actual descriptor-relative helper. */
export function testPackageMutations(root: string): WorkspaceDirectoryMutations {
  return {
    async ensureDirectory(relative, mode = 0o700) {
      await mkdir(join(root, relative), { recursive: true, mode });
    },
    async createStage(relative) {
      await mkdir(join(root, relative), { mode: 0o700 });
    },
    async stagePackage(relative, files, directories) {
      const target = join(root, relative);
      await mkdir(target, { mode: 0o700 });
      for (const path of directories.keys()) {
        if (path) await mkdir(join(target, path), { recursive: true, mode: 0o700 });
      }
      for (const [path, file] of files) {
        if (!(file.mode & 0o400)) throw new Error('Installed skill files must be readable by their owner.');
        const destination = join(target, path);
        await writeFile(destination, file.bytes, { flag: 'wx', mode: 0o600 });
        await chmod(destination, file.mode);
      }
      for (const [path, mode] of [...directories].toSorted(([a], [b]) => b.length - a.length))
        await chmod(join(target, path), mode);
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
