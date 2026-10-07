import { createHash } from 'node:crypto';
import type { ProjectContextKind } from './ProjectContextKind.ts';

/** Deterministically identifies a project container across Glyph processes. */
export class ProjectContextIdentity {
  static create(kind: ProjectContextKind, authority: string, identity: string): string {
    return createHash('sha256')
      .update(JSON.stringify({ version: 1, kind, authority, identity }))
      .digest('hex');
  }
}
