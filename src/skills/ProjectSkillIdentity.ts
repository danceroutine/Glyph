import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, sep } from 'node:path';
import { skillPackageId } from './skillPackageId.ts';

/** The containing project scope owns a package even when the IDE opens a parent of that scope. */
export class ProjectSkillIdentity {
  constructor(
    private readonly root: string,
    private readonly location: string,
  ) {}

  get originId(): string {
    return this.origin(this.root);
  }

  forDirectory(directory: string): string {
    const packagePath = join(this.root, directory);
    const scope = dirname(dirname(dirname(packagePath)));
    return skillPackageId(this.origin(scope), [this.location, 'skills', basename(packagePath)].join('/'));
  }

  /** Verify one historical selection against this exact physical package. */
  matchesLegacyId(directory: string, id: string, budget: { remaining: number }): boolean {
    if (/^skill-sha256:[a-f0-9]{64}$/u.test(id)) {
      const absolute = join(this.root, directory);
      // Only ancestors whose qualified package path exceeded the historical wire limit could have this ID.
      if (absolute.length + this.originId.length + 1 <= 500) return false;
      for (const ancestor of this.ancestors(absolute)) {
        if (budget.remaining <= 0) return false;
        budget.remaining--;
        if (skillPackageId(this.origin(ancestor), relative(ancestor, absolute).split(sep).join('/')) === id)
          return true;
      }
      return false;
    }
    const prefix = /^project:[a-f0-9]{16}:(\.glyph|\.cursor):/u.exec(id);
    if (!prefix || prefix[1] !== this.location) return false;
    const oldDirectory = id.slice(prefix[0].length);
    const absolute = join(this.root, directory);
    const owner = oldDirectory.split('/').reduce(path => dirname(path), absolute);
    return (
      relative(owner, absolute).split(sep).join('/') === oldDirectory &&
      skillPackageId(this.origin(owner), oldDirectory) === id
    );
  }

  /** Old preferences used the attached ancestor and a directory relative to that ancestor. */
  legacyIds(directory: string): string[] {
    const packagePath = join(this.root, directory);
    return [...this.ancestors(packagePath)].map(root =>
      skillPackageId(this.origin(root), relative(root, packagePath).split(sep).join('/')),
    );
  }

  private *ancestors(packagePath: string): Iterable<string> {
    let root = dirname(dirname(dirname(packagePath)));
    while (dirname(root) !== root) {
      root = dirname(root);
      yield root;
    }
  }

  private origin(root: string): string {
    return 'project:' + createHash('sha256').update(root).digest('hex').slice(0, 16) + ':' + this.location;
  }
}
