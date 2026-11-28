import { basename, dirname, join, normalize, parse, sep } from 'node:path';
import { normalizeVolumeName } from './FilesystemNamePolicy.ts';
import fs from 'node:fs';

/** Match configured and indexed spellings of one directory, including a mount below the workspace.
 * An absent target can use its configured casing until there is an entry to compare.
 */
export function sameWorkspaceDirectory(first: string, second: string, caseSensitive: boolean): boolean {
  if (first === second) return true;
  try {
    const a = fs.lstatSync(first, { bigint: true, throwIfNoEntry: false });
    const b = fs.lstatSync(second, { bigint: true, throwIfNoEntry: false });
    if (!a && !b)
      return (
        (basename(first) === basename(second) ||
          (!caseSensitive && basename(first).toLowerCase() === basename(second).toLowerCase())) &&
        sameWorkspaceDirectory(dirname(first), dirname(second), caseSensitive)
      );
    return a?.dev === b?.dev && a?.ino === b?.ino;
  } catch {
    return false;
  }
}

/** Managed marker syntax admits filesystem-equivalent spellings of its reserved names. */
export function sameWorkspaceDirectorySpelling(first: string, second: string, caseSensitive: boolean): boolean {
  const folding = { normalizesUnicode: true, foldsUnicode: true };
  return (
    normalizeVolumeName(first, folding) === normalizeVolumeName(second, folding) &&
    sameWorkspaceDirectory(first, second, caseSensitive)
  );
}

/** Project a saved absolute path under a selected directory. Every differently spelled component
 * must name the same existing entry so a sibling directory or a separate symlink cannot supply it. */
export function relativeWorkspaceSpelling(anchor: string, selected: string): string | undefined {
  anchor = normalize(anchor);
  selected = normalize(selected);
  const root = parse(anchor).root;
  const selectedRoot = parse(selected).root;
  if (!root || root.toLowerCase() !== selectedRoot.toLowerCase()) return undefined;
  const prefix = anchor.slice(root.length).split(sep).filter(Boolean);
  const parts = selected.slice(selectedRoot.length).split(sep).filter(Boolean);
  if (parts.length < prefix.length) return undefined;
  for (const [index, name] of prefix.entries()) {
    if (name === parts[index]) continue;
    const current = join(root, ...prefix.slice(0, index + 1));
    const saved = join(selectedRoot, ...parts.slice(0, index + 1));
    if (!sameWorkspaceDirectorySpelling(current, saved, true)) return undefined;
  }
  return parts.slice(prefix.length).join(sep);
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
