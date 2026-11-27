import { lstat, opendir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readHostFile } from './readHostFile.ts';
import { fileRevision, packageRevision, type SkillFileIdentity } from './skillPackageRevision.ts';
import { optionalStat } from './SkillPackageStorage.ts';
/** Bounded physical inventory detects omitted sensitive files and unsupported nodes before a directory swap. */
export async function inventoryPackage(root: string, signal?: AbortSignal) {
  const files: string[] = [];
  const directories: string[] = [];
  const rootStat = await optionalStat(root);
  if (!rootStat) return { files, directories };
  if (!rootStat.isDirectory()) throw new Error('Skill package must be a real directory.');
  let nodes = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('Skill package nesting exceeds 32 levels.');
    signal?.throwIfAborted();
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (++nodes > 8450) throw new Error('Skill package exceeds its directory budget.');
      const path = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        directories.push(path);
        await visit(join(directory, entry.name), path, depth + 1);
      } else if (entry.isFile()) {
        files.push(path);
        if (files.length > 256) throw new Error('Skill package exceeds 256 files.');
      } else throw new Error('Skill packages cannot contain symlinks or special files.');
    }
  };
  await visit(root, '', 0);
  return { files, directories };
}

export async function inventoryFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  return (await inventoryPackage(root, signal)).files;
}

/** Read access modes only after authorizing package-relative directory names. */
export async function readDirectoryModes(directories: readonly string[], resolve: (path: string) => Promise<string>) {
  const modes = new Map<string, number>();
  for (const path of directories) {
    const stat = await lstat(await resolve(path));
    if (!stat.isDirectory()) throw new Error('The skill directory changed. Review the package again.');
    modes.set(path, stat.mode & 0o777);
  }
  return modes;
}

/** Hash the files selected by a lifecycle transaction in its guarded target or rollback directory.
 * Only revisions and modes leave this operation. Source and catalog readers use their own agent-facing authority. */
export async function diskRevision(root: string, treeVersion?: 2): Promise<string | null> {
  if (!(await optionalStat(root))) return null;
  const { files: paths, directories } = await inventoryPackage(root);
  const physical = await realpath(root);
  const modes = treeVersion && (await readDirectoryModes(directories, async path => join(physical, path)));
  const files = new Map<string, SkillFileIdentity>();
  let bytes = 0;
  for (const path of paths) {
    const file = await readHostFile(join(physical, path), 1024 * 1024);
    bytes += file.bytes.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Skill package exceeds 8 MiB.');
    files.set(path, { revision: fileRevision(file.bytes), mode: file.mode });
  }
  return packageRevision(files, modes);
}
