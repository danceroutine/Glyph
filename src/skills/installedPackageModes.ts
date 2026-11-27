import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillPackageFile } from './SkillPackage.ts';

/** Inherit permissions only from an inventoried object the proposed spelling actually opens. */
export async function installedPackageModes(
  root: string,
  proposed: Iterable<string>,
  before: { files: ReadonlyMap<string, SkillPackageFile>; directories: ReadonlyMap<string, number> },
) {
  const files = new Map(before.files);
  const directories = new Map(before.directories);
  if (files.size === 0) return { files, directories };
  const identity = async (name: string) => {
    const stat = await lstat(join(root, name), { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      return undefined;
    });
    return stat && `${stat.dev}:${stat.ino}`;
  };
  let stored: Map<string, string> | undefined;
  for (const name of proposed) {
    if (files.has(name) || directories.has(name)) continue;
    const object = await identity(name);
    if (!object) continue;
    if (!stored) {
      stored = new Map();
      for (const path of [...before.files.keys(), ...before.directories.keys()]) {
        const key = await identity(path);
        if (key) stored.set(key, path);
      }
    }
    const original = stored.get(object);
    if (original === undefined)
      throw new Error('The installed skill changed while comparing permissions. Preview it again.');
    const file = before.files.get(original);
    if (file) files.set(name, file);
    else directories.set(name, before.directories.get(original)!);
  }
  return { files, directories };
}
