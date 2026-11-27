import { sameWorkspaceDirectory, WorkspaceDirectoryIdentity } from '#src/workspace/sameWorkspaceDirectory.js';
import { basename, dirname, join } from 'node:path';
import { ProjectSkillIdentity } from './ProjectSkillIdentity.ts';

/** The configured user store owns its packages through every attached project route. */
export class UserSkillDirectory {
  readonly path: string;
  private readonly projectIdentity?: ProjectSkillIdentity;
  private readonly marker: string;
  private readonly store: WorkspaceDirectoryIdentity;

  constructor(userDirectory: string, caseSensitive: boolean) {
    this.path = join(userDirectory, 'skills');
    this.store = new WorkspaceDirectoryIdentity(this.path, caseSensitive);
    this.marker = basename(userDirectory);
    const location = ['.glyph', '.cursor'].find(name =>
      sameWorkspaceDirectory(userDirectory, join(dirname(userDirectory), name), caseSensitive),
    );
    if (location) this.projectIdentity = new ProjectSkillIdentity(dirname(userDirectory), location);
  }

  ownsStore(directory: string): boolean {
    return this.store.matches(directory);
  }

  matchesProjectReference(directory: string, id: string, budget: { remaining: number }): boolean {
    if (!this.projectIdentity) return false;
    const projectDirectory = this.marker + '/' + directory;
    return (
      this.projectIdentity.forDirectory(projectDirectory) === id ||
      this.projectIdentity.matchesLegacyId(projectDirectory, id, budget)
    );
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
