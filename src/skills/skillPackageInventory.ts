import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { optionalStat } from './SkillPackageStorage.ts';
/** Bounded physical inventory detects omitted sensitive files and unsupported nodes before a directory swap. */
export async function inventoryFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const result: string[] = [];
  const rootStat = await optionalStat(root);
  if (!rootStat) return result;
  if (!rootStat.isDirectory()) throw new Error('Skill package must be a real directory.');
  let nodes = 0;
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('Skill package nesting exceeds 32 levels.');
    signal?.throwIfAborted();
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (++nodes > 8450) throw new Error('Skill package exceeds its directory budget.');
      const path = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), path, depth + 1);
      else if (entry.isFile()) {
        result.push(path);
        if (result.length > 256) throw new Error('Skill package exceeds 256 files.');
      } else throw new Error('Skill packages cannot contain symlinks or special files.');
    }
  };
  await visit(root, '', 0);
  return result;
}

export async function readPackageFiles(root: string, paths: readonly string[], signal?: AbortSignal) {
  const store = new FileSystemWorkspaceTextStore(root);
  const files = new Map<string, Awaited<ReturnType<typeof store.readBytes>>>();
  let bytes = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const file = await store.readBytes(path, { maxBytes: 1024 * 1024 });
    bytes += file.bytes.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Skill package exceeds 8 MiB.');
    files.set(path, file);
  }
  return files;
}
