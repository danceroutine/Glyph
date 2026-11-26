import { dirname, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectMutationPolicy } from '#src/editing/proposals/ProjectMutationPolicy.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import type { SkillCatalog } from './SkillCatalog.ts';
import type { SkillDescriptor } from './SkillDescriptor.ts';

interface PackageLocation {
  readonly store: Pick<WorkspaceTextStore, 'root' | 'caseSensitive'>;
  readonly directory: string;
}

const denial = 'Skill packages require review. Use skills.propose_change or open Skills in Glyph Settings.';

/** Covers new and existing native and compatibility packages, including packages nested inside project folders. */
export class SkillProjectMutationPolicy implements ProjectMutationPolicy {
  private previous?: readonly SkillDescriptor[];
  private readonly ancestors = new Set<string>();
  private readonly roots: readonly { path: string; directory: string; sensitive: boolean }[];

  constructor(
    locations: readonly PackageLocation[] = [],
    private readonly catalog?: Pick<SkillCatalog, 'skills'>,
  ) {
    this.roots = locations
      .map(({ store, directory }) => {
        const path = key(store.root, store.caseSensitive);
        return {
          path,
          directory: posix.join(path, key(directory, store.caseSensitive)),
          sensitive: store.caseSensitive,
        };
      })
      .toSorted((left, right) => right.path.length - left.path.length);
    for (const root of this.roots) this.addAncestors(root.directory);
  }

  getDenial(canonicalPath: string): string | undefined {
    const parts = canonicalPath.split('/');
    if (
      parts.some(
        (part, index) =>
          (part === '.glyph' || part === '.cursor') && (index + 1 === parts.length || parts[index + 1] === 'skills'),
      )
    )
      return denial;
    if (this.roots.some(root => contains(root.directory, canonicalPath))) return denial;
    const skills = this.catalog?.skills;
    if (skills && skills !== this.previous) {
      this.ancestors.clear();
      for (const root of this.roots) this.addAncestors(root.directory);
      for (const skill of skills) {
        if (!skill.uri.startsWith('file:')) continue;
        const directory = dirname(fileURLToPath(skill.uri));
        const root = this.roots.find(candidate => {
          const path = key(directory, candidate.sensitive);
          return contains(candidate.path, path);
        });
        if (root) this.addAncestors(key(directory, root.sensitive));
      }
      this.previous = skills;
    }
    return this.ancestors.has(canonicalPath) ? denial : undefined;
  }

  private addAncestors(directory: string): void {
    for (let path = directory; !this.ancestors.has(path); path = posix.dirname(path)) this.ancestors.add(path);
  }
}

function contains(root: string, path: string): boolean {
  return root === path || path.startsWith(root.endsWith('/') ? root : root + '/');
}

function key(path: string, sensitive: boolean): string {
  const normalized = path.split(sep).join('/');
  return sensitive ? normalized : normalized.toLowerCase();
}
