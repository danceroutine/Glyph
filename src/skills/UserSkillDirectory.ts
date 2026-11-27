import { basename, dirname, join } from 'node:path';
import { ProjectSkillIdentity } from './ProjectSkillIdentity.ts';

/** The configured user store owns its packages through every attached project route. */
export class UserSkillDirectory {
  readonly path: string;
  private readonly projectIdentity?: ProjectSkillIdentity;
  private readonly marker: string;

  constructor(
    userDirectory: string,
    private readonly caseSensitive: boolean,
  ) {
    this.path = join(userDirectory, 'skills');
    this.marker = basename(userDirectory);
    const location = this.key(this.marker);
    if (location === '.glyph' || location === '.cursor')
      this.projectIdentity = new ProjectSkillIdentity(dirname(userDirectory), location);
  }

  ownsStore(directory: string): boolean {
    return this.key(directory) === this.key(this.path);
  }

  matchesProjectReference(directory: string, id: string, budget: { remaining: number }): boolean {
    if (!this.projectIdentity) return false;
    const projectDirectory = this.marker + '/' + directory;
    return (
      this.projectIdentity.forDirectory(projectDirectory) === id ||
      this.projectIdentity.matchesLegacyId(projectDirectory, id, budget)
    );
  }

  private key(path: string): string {
    return this.caseSensitive ? path : path.toLowerCase();
  }
}
