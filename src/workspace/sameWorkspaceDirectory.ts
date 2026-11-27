import fs from 'node:fs';
import { normalizeVolumeName } from './FilesystemNamePolicy.ts';

/** Match configured and indexed spellings of one directory, including a mount below the workspace.
 * An absent target can use its configured casing until there is an entry to compare.
 */
export function sameWorkspaceDirectory(first: string, second: string, caseSensitive: boolean): boolean {
  if (first === second) return true;
  const folding = { normalizesUnicode: true, foldsUnicode: true };
  if (normalizeVolumeName(first, folding) !== normalizeVolumeName(second, folding)) return false;
  try {
    const a = fs.lstatSync(first, { bigint: true, throwIfNoEntry: false });
    const b = fs.lstatSync(second, { bigint: true, throwIfNoEntry: false });
    if (!a && !b) return !caseSensitive && first.toLowerCase() === second.toLowerCase();
    return a?.dev === b?.dev && a?.ino === b?.ino;
  } catch {
    return false;
  }
}

/** A catalog can encounter the same profile directory for every package or rule in one listing.
 * Share that comparison within the synchronous batch and recheck after the next filesystem change.
 */
export class WorkspaceDirectoryIdentity {
  private readonly spellings = new Map<string, boolean>();
  constructor(
    private readonly directory: string,
    private readonly caseSensitive: boolean,
  ) {}
  matches(path: string): boolean {
    const cached = this.spellings.get(path);
    if (cached !== undefined) return cached;
    const matches = sameWorkspaceDirectory(this.directory, path, this.caseSensitive);
    if (this.spellings.size === 0)
      queueMicrotask(() => {
        this.spellings.clear();
      });
    this.spellings.set(path, matches);
    return matches;
  }
}
