import { relative, resolve, sep } from 'node:path';
import type { GlyphConnectionIdentity } from '#src/desktop/protocol/connection/GlyphConnectionIdentity.js';
import type { GlyphWorkspaceRoot } from '#src/desktop/protocol/connection/GlyphWorkspaceRoot.js';

/** Describes whether a window may mutate a workspace and where to redirect focus if not. */
export interface WorkspaceOwnership {
  readonly ownerWindowId: string;
  readonly readOnly: boolean;
  readonly focusOwnerWindowId?: string;
}

interface OwnerRecord extends GlyphConnectionIdentity {
  readonly roots: readonly string[];
}

export enum WorkspaceOwnershipErrorCode {
  EMPTY_WORKSPACE = 'EMPTY_WORKSPACE',
  ROOTS_CHANGED = 'ROOTS_CHANGED',
  ROOTS_OVERLAP = 'ROOTS_OVERLAP',
}

/** Preserves a machine-readable ownership failure within the host process. */
export class WorkspaceOwnershipError extends Error {
  constructor(
    readonly code: WorkspaceOwnershipErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceOwnershipError';
  }
}

/**
 * Prevents two runtimes from mutating the same files through different windows
 * or workspace identities. Secondary windows may observe an existing runtime,
 * but only its owning window receives mutation authority.
 */
export class WorkspaceOwnershipRegistry {
  private readonly owners = new Map<string, OwnerRecord>();

  acquire(identity: GlyphConnectionIdentity, roots: readonly GlyphWorkspaceRoot[]): WorkspaceOwnership {
    if (roots.length === 0) {
      throw new WorkspaceOwnershipError(
        WorkspaceOwnershipErrorCode.EMPTY_WORKSPACE,
        'A desktop workspace requires at least one local root.',
      );
    }
    const canonicalRoots = roots.map(root => resolve(root.canonicalPath));
    const existingOwner = this.owners.get(getWorkspaceKey(identity));
    if (!existingOwner) {
      const conflict = [...this.owners.values()].find(owner => rootsOverlap(owner.roots, canonicalRoots));
      if (conflict) {
        throw new WorkspaceOwnershipError(
          WorkspaceOwnershipErrorCode.ROOTS_OVERLAP,
          `Workspace roots overlap the Glyph session owned by window ${conflict.windowId}.`,
        );
      }
      this.owners.set(getWorkspaceKey(identity), { ...identity, roots: canonicalRoots });
      return { ownerWindowId: identity.windowId, readOnly: false };
    }
    if (!areSameRoots(existingOwner.roots, canonicalRoots)) {
      throw new WorkspaceOwnershipError(
        WorkspaceOwnershipErrorCode.ROOTS_CHANGED,
        'Workspace roots changed without detaching the existing owner.',
      );
    }
    if (existingOwner.windowId === identity.windowId) {
      return { ownerWindowId: identity.windowId, readOnly: false };
    }
    return {
      ownerWindowId: existingOwner.windowId,
      readOnly: true,
      focusOwnerWindowId: existingOwner.windowId,
    };
  }

  /** Releases authority only when called by the owning window. */
  release(identity: GlyphConnectionIdentity): boolean {
    const key = getWorkspaceKey(identity);
    const owner = this.owners.get(key);
    if (!owner || owner.windowId !== identity.windowId) return false;
    this.owners.delete(key);
    return true;
  }

  getOwnerWindowId(identity: Pick<GlyphConnectionIdentity, 'profileId' | 'workspaceId'>): string | undefined {
    return this.owners.get(getWorkspaceKey(identity))?.windowId;
  }
}

/** Produces the shared runtime key used by ownership and host coordination. */
export function getWorkspaceKey(identity: Pick<GlyphConnectionIdentity, 'profileId' | 'workspaceId'>): string {
  return `${identity.profileId}\0${identity.workspaceId}`;
}

function areSameRoots(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((root, index) => root === sortedRight[index]);
}

function rootsOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => contains(a, b) || contains(b, a)));
}

function contains(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}
