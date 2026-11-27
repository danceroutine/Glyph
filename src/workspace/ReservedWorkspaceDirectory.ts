import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeVolumeName } from './FilesystemNamePolicy.ts';
import { workspaceCaseSensitivity } from './workspaceCaseSensitivity.ts';

/** Native transaction directory names. Actual entry and parent-volume identity decide alternate spellings. */
export const privateDirectories = ['.skill-staging'];

export function isPrivateDirectory(
  name: string,
  caseSensitive: boolean,
  path?: string,
  physicalGuard = false,
): boolean {
  if (privateDirectories.includes(name)) return true;
  // Only possible aliases require a filesystem lookup. Ordinary components stay on the fast path.
  if (!name.startsWith('.')) return false;
  const reserved = normalizeVolumeName(name, { normalizesUnicode: true, foldsUnicode: true });
  if (!privateDirectories.includes(reserved)) return false;
  if (path === undefined) return !caseSensitive;
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  const other = lstatSync(join(dirname(path), reserved), { bigint: true, throwIfNoEntry: false });
  if (entry || other) return entry?.dev === other?.dev && entry?.ino === other?.ino;
  // Native path admission verifies prospective names on their nearest existing ancestor.
  return !physicalGuard && !workspaceCaseSensitivity(dirname(path));
}
