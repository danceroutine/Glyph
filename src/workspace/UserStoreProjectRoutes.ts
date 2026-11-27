import { readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  sameWorkspaceDirectory,
  sameWorkspaceDirectorySpelling,
  WorkspaceDirectoryIdentity,
} from './sameWorkspaceDirectory.ts';
import { storedSourcePath, type SourcePathAliases } from './SourcePathAliases.ts';

/** Snapshot a user store's visible mount routes once for a catalog listing. Verify each claimed object on use. */
export class UserStoreProjectRoutes {
  private aliases: readonly string[] | undefined;
  private readonly store: WorkspaceDirectoryIdentity;
  constructor(
    private readonly directory: string,
    private readonly caseSensitive: boolean,
    private readonly resolveAliases: SourcePathAliases = path => [storedSourcePath(path)],
  ) {
    this.store = new WorkspaceDirectoryIdentity(directory, caseSensitive);
  }

  refresh(): void {
    this.aliases = this.resolveAliases(this.directory, true);
  }

  ownsStore(path: string): boolean {
    return this.store.matches(path);
  }

  ownsEntry(path: string): boolean {
    if (this.ownsStore(dirname(path))) return true;
    const aliases = this.visibleRoutes();
    if (aliases.length <= 1 || !aliases.includes(storedSourcePath(path))) return false;
    // A mount of one package or rule file has a separate parent and can have a different basename.
    return readdirSync(this.directory).some(name => sameWorkspaceDirectory(join(this.directory, name), path, true));
  }

  projectEntries(name: string): string[] {
    const result = new Set<string>();
    for (const route of this.visibleRoutes()) {
      if (this.ownsStore(route)) {
        const entry = join(route, name);
        if (sameWorkspaceDirectory(join(this.directory, name), entry, this.caseSensitive)) result.add(entry);
      } else if (sameWorkspaceDirectory(route, join(this.directory, name), this.caseSensitive)) result.add(route);
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

  private visibleRoutes(): readonly string[] {
    this.aliases ??= this.resolveAliases(this.directory, true);
    return this.aliases;
  }
}
