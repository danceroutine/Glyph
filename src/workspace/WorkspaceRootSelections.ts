import fs, { constants } from 'node:fs';

/**
 * Owns the directory descriptors selected by one desktop attachment or CLI session.
 * The logical name must still reach the same physical directory when an operation starts
 * and when its result or mutation is delivered. Keeping the descriptor open prevents inode
 * reuse after removal. Disposing the session invalidates every outstanding guard.
 */
export class WorkspaceRootSelections {
  private readonly directories = new Map<number, { path: string; assertCurrent: () => void }>();
  private disposed = false;

  /** Pin an attached route at selection. The caller retains its check through the final operation handoff. */
  select(selected: string, physical = fs.realpathSync.native(selected)) {
    if (this.disposed) throw new Error('The workspace selection has ended.');
    const descriptor = fs.openSync(physical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const pinned = fs.fstatSync(descriptor, { bigint: true });
      const assertCurrent = () => {
        if (this.disposed) throw new Error('The workspace selection has ended.');
        const current = fs.statSync(selected, { bigint: true, throwIfNoEntry: false });
        if (current?.dev !== pinned.dev || current.ino !== pinned.ino || fs.realpathSync.native(selected) !== physical)
          throw new Error('The selected workspace folder changed.');
      };
      assertCurrent();
      const selection = { path: physical, assertCurrent };
      this.directories.set(descriptor, selection);
      return selection;
    } catch (error) {
      fs.closeSync(descriptor);
      throw error;
    }
  }

  /** A shell working directory is physical. Recheck the selected routes that granted access to its root. */
  assertCurrent(physical: string): void {
    let found = false;
    for (const selection of this.directories.values()) {
      if (selection.path === physical) {
        selection.assertCurrent();
        found = true;
      }
    }
    if (!found) throw new Error('The workspace folder is no longer selected.');
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    for (const descriptor of this.directories.keys()) fs.closeSync(descriptor);
    this.directories.clear();
  }
}
