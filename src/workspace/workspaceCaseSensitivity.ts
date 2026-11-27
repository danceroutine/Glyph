import { opendirSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function directoryExists(path: string) {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

/** A new optional store inherits its existing directory ancestor's filesystem until it is created. */
export function filesystemPolicyDirectory(path: string): string {
  let current = resolve(path);
  while (current !== dirname(current) && !directoryExists(current)) current = dirname(current);
  return current;
}

/** Case policy for standalone stores without a native index. Inspect existing names without modifying the workspace. */
export function workspaceCaseSensitivity(root: string): boolean {
  const directory = realpathSync(filesystemPolicyDirectory(root));
  try {
    const entries = opendirSync(directory);
    try {
      const names = new Set<string>();
      for (let count = 0; count < 64; count++) {
        const entry = entries.readSync();
        if (!entry) break;
        names.add(entry.name);
      }
      for (const name of names) {
        const sensitive = compareName(directory, name, names);
        if (sensitive !== undefined) return sensitive;
      }
    } finally {
      entries.closeSync();
    }
  } catch {
    /* Inaccessible or changing entries can still use the parent volume. */
  }
  // Empty folders on the same volume can use their own existing name in their parent.
  const parent = dirname(directory);
  if (parent !== directory && statSync(parent).dev === statSync(directory).dev) {
    const sensitive = compareName(parent, basename(directory));
    if (sensitive !== undefined) return sensitive;
  }
  return process.platform !== 'win32' && process.platform !== 'darwin';
}

function compareName(directory: string, name: string, siblings?: ReadonlySet<string>) {
  const other = name.replace(/[a-zA-Z]/u, letter =>
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
  );
  if (other === name) return undefined;
  if (siblings?.has(other)) return true;
  const alternative = lstatSync(join(directory, other), { throwIfNoEntry: false, bigint: true });
  if (!alternative) return true;
  const actual = lstatSync(join(directory, name), { throwIfNoEntry: false, bigint: true });
  if (!actual) return undefined;
  if (actual.dev !== alternative.dev || actual.ino !== alternative.ino) return true;
  // Two independently listed hardlinks on a case-sensitive filesystem can name the same inode.
  return actual.nlink === 1n || actual.isDirectory() ? false : undefined;
}
