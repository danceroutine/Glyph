import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  sameWorkspaceDirectory,
  sameWorkspaceDirectorySpelling,
  WorkspaceDirectoryIdentity,
} from './sameWorkspaceDirectory.ts';
import { storedSourcePath, type SourcePathAliases } from './SourcePathAliases.ts';

function objectId(path: string): string | undefined {
  const entry = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return entry && `${entry.dev}:${entry.ino}`;
}

/** Snapshot a user store's visible mount routes once for a catalog listing. Verify each claimed object on use. */
export class UserStoreProjectRoutes {
  private snapshot?: ReturnType<UserStoreProjectRoutes['index']>;
  private entries: Map<string, string> | undefined;
  private readonly store: WorkspaceDirectoryIdentity;
  constructor(
    private readonly directory: string,
    private readonly caseSensitive: boolean,
    private readonly resolveAliases: SourcePathAliases = path => [storedSourcePath(path)],
  ) {
    this.store = new WorkspaceDirectoryIdentity(directory, caseSensitive);
  }

  refresh(): void {
    this.snapshot = this.index();
    this.entries = undefined;
  }

  ownsStore(path: string): boolean {
    return this.store.matches(path);
  }

  ownsEntry(path: string): boolean {
    if (this.ownsStore(dirname(path))) return true;
    const { mounted } = (this.snapshot ??= this.index());
    if (!mounted.size) return false;
    const id = objectId(path);
    if (!id || !mounted.has(id)) return false;
    // A direct mount of one entry can rename it. Inventory the profile once, only when such a mount is observed.
    if (!this.entries) {
      const entries = new Map<string, string>();
      for (const name of fs.readdirSync(this.directory)) {
        const entry = join(this.directory, name);
        const key = objectId(entry);
        if (key) entries.set(key, entry);
      }
      this.entries = entries;
    }
    const entry = this.entries.get(id);
    return entry !== undefined && sameWorkspaceDirectory(entry, path, this.caseSensitive);
  }

  projectEntries(name: string): string[] {
    const { stores, mounted } = (this.snapshot ??= this.index());
    const user = join(this.directory, name);
    const result = new Set<string>();
    for (const store of stores) {
      const entry = join(store, name);
      if (sameWorkspaceDirectory(user, entry, this.caseSensitive)) result.add(entry);
    }
    if (mounted.size) {
      const id = objectId(user);
      if (id)
        for (const route of mounted.get(id) ?? []) {
          if (sameWorkspaceDirectory(user, route, this.caseSensitive)) result.add(route);
        }
    }
    return [...result];
  }

  projectMarker(entry: string): '.glyph' | '.cursor' | undefined {
    const store = dirname(entry);
    const marker = dirname(store);
    if (!sameWorkspaceDirectorySpelling(store, join(marker, basename(this.directory)), this.caseSensitive))
      return undefined;
    return (['.glyph', '.cursor'] as const).find(name =>
      sameWorkspaceDirectorySpelling(marker, join(dirname(marker), name), this.caseSensitive),
    );
  }

  private index() {
    const stores: string[] = [];
    const mounted = new Map<string, string[]>();
    for (const route of this.resolveAliases(this.directory, true)) {
      if (this.ownsStore(route)) stores.push(route);
      else {
        const id = objectId(route);
        if (!id) continue;
        const group = mounted.get(id);
        if (group) group.push(route);
        else mounted.set(id, [route]);
      }
    }
    return { stores, mounted };
  }
}
