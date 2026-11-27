import { UserStoreProjectRoutes } from '#src/workspace/UserStoreProjectRoutes.js';
import type { SourcePathAliases } from '#src/workspace/SourcePathAliases.js';
import { basename, dirname, join, relative, sep } from 'node:path';
import { ProjectSkillIdentity } from './ProjectSkillIdentity.ts';

/** The configured user store owns its packages through every attached project route. */
export class UserSkillDirectory {
  readonly path: string;
  private readonly store: UserStoreProjectRoutes;

  constructor(userDirectory: string, caseSensitive: boolean, aliases?: SourcePathAliases) {
    this.path = join(userDirectory, 'skills');
    this.store = new UserStoreProjectRoutes(this.path, caseSensitive, aliases);
  }

  refresh(): void {
    this.store.refresh();
  }

  ownsStore(directory: string): boolean {
    return this.store.ownsStore(directory);
  }

  ownsPackage(directory: string): boolean {
    return this.store.ownsEntry(directory);
  }

  matchesProjectReference(directory: string, id: string, budget: { remaining: number }): boolean {
    for (const { identity, route } of this.projectRoutes(directory)) {
      if (identity.forDirectory(route) === id || identity.matchesLegacyId(route, id, budget)) return true;
    }
    return false;
  }

  private *projectRoutes(directory: string) {
    for (const entry of this.store.projectEntries(basename(directory))) {
      const location = this.store.projectMarker(entry);
      if (!location) continue;
      const root = dirname(dirname(dirname(entry)));
      yield { identity: new ProjectSkillIdentity(root, location), route: relative(root, entry).split(sep).join('/') };
    }
  }

  previousPackageIds(directory: string): readonly string[] {
    return [
      ...new Set(
        [...this.projectRoutes(directory)].flatMap(({ identity, route }) => [
          identity.forDirectory(route),
          ...identity.legacyIds(route),
        ]),
      ),
    ];
  }
}
