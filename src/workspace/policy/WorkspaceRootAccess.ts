import { resolve } from 'node:path';
import type { WorkspaceAccessPolicy } from './WorkspaceAccessPolicy.ts';

/**
 * Projects a host's reservations into one attached root for its store and native index. Bind once per root and
 * retain the returned operation through publication or result delivery. A new policy generation invalidates
 * earlier operations and refreshes the projected paths for the next caller.
 */
export class WorkspaceRootAccess {
  private operation: ReturnType<WorkspaceRootAccess['project']> | undefined;

  constructor(
    readonly policy: WorkspaceAccessPolicy,
    readonly root: string,
    readonly caseSensitive: boolean,
    private readonly excludedPaths: readonly string[] = [],
  ) {}

  beginOperation() {
    const revision = this.policy.revision;
    if (!this.operation || this.operation.revision !== revision) this.operation = this.project(revision);
    return this.operation;
  }

  private project(revision: number) {
    const snapshot = this.policy.beginOperation();
    const projected = this.policy.exclusionsFor(this.root, this.caseSensitive, 'native');
    return {
      revision,
      assertCurrent: snapshot.assertCurrent,
      privateRoot: projected.privateRoot,
      privatePaths: [
        ...new Set([...snapshot.privatePaths, ...this.excludedPaths.map(path => resolve(this.root, path))]),
      ],
      excludedPaths: [...new Set([...this.excludedPaths, ...projected.excludedPaths])],
    };
  }
}
