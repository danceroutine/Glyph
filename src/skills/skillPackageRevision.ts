import { createHash } from 'node:crypto';

export interface SkillFileIdentity {
  readonly revision: string;
  readonly mode: number;
}

/** Parents containing a regular file are already represented by that file's path. */
export function fileDirectories(paths: Iterable<string>): Set<string> {
  const names = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) names.add(parts.slice(0, i).join('/'));
  }
  return names;
}

/** The approval, installation and activation identify the same paths, bytes and access modes. */
export function packageRevision(
  files: ReadonlyMap<string, SkillFileIdentity>,
  directories: ReadonlyMap<string, number> = new Map(),
): string {
  const entries: (number | string)[][] = [...files.keys()].toSorted().map(path => {
    const file = files.get(path)!;
    return [path, file.revision, file.mode & 0o777];
  });
  for (const path of [...directories.keys()].toSorted()) {
    entries.push([path, 'directory', '', directories.get(path)!]);
  }
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function fileRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
