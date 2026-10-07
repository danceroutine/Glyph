import { createHash } from 'node:crypto';
import type { ProjectContextKind } from './ProjectContextKind.ts';
import type { ProjectRoot } from './ProjectRoot.ts';

/** Deterministically identifies a project container across Glyph processes. */
export class ProjectContextIdentity {
  static create(kind: ProjectContextKind, authority: string, identity: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ version: 1, kind, authority, identity }))
      .digest('hex');
  }

  /** Binds persisted mutations to the exact canonical root names and paths they were compiled against. */
  static createMutationScope(kind: ProjectContextKind, authority: string, roots: readonly ProjectRoot[]): string {
    const canonicalRoots = [...roots].sort((left, right) =>
      left.name === right.name ? compare(left.path, right.path) : compare(left.name, right.name),
    );
    return createHash('sha256')
      .update(JSON.stringify({ version: 1, kind, authority, roots: canonicalRoots }))
      .digest('hex');
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
