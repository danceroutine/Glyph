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

  /** Old preferences used the attached ancestor and a directory relative to that ancestor. */
  legacyIds(directory: string): string[] {
    const packagePath = join(this.root, directory);
    const scope = dirname(dirname(dirname(packagePath)));
    const current = this.forDirectory(directory);
    const ids = [];
    for (let root = scope; ;) {
      const previous = skillPackageId(this.origin(root), relative(root, packagePath).split(sep).join('/'));
      if (previous !== current) ids.push(previous);
      const parent = dirname(root);
      if (parent === root) break;
      root = parent;
    }
    return ids;
  }

  private origin(root: string): string {
    return 'project:' + createHash('sha256').update(root).digest('hex').slice(0, 16) + ':' + this.location;
  }
}
