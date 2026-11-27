import { resolve } from 'node:path';

/**
 * Owns the host's accumulated reservations across live windows. Retain both
 * logical names and known physical paths for the host lifetime, including
 * after a route disappears. Workspace policies read the current snapshot at
 * use, and physical adapters check the target of the operation against it.
 */
export class WorkspaceProtectedPathRegistry {
  private readonly paths = new Set<string>();
  private snapshot: readonly string[] = [];

  /** Reserve logical and previously resolved physical names before opening host-owned state. */
  admit(paths: readonly string[]): void {
    const size = this.paths.size;
    for (const path of paths) this.paths.add(resolve(path));
    if (this.paths.size !== size) this.snapshot = Object.freeze([...this.paths]);
  }

  /** Immutable current reservations; policies can observe this without capturing a stale array. */
  get current(): readonly string[] {
    return this.snapshot;
  }
}
