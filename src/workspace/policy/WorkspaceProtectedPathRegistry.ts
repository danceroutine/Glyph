import { resolve } from 'node:path';

/** Host-lifetime private and managed-path reservations shared by all live workspace policies. Admitted paths remain protected after retargeting. */
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
