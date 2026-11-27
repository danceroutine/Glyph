import { Deferred } from '#src/shared/Deferred.js';

/** The roots owned by this host, including peers retained through reconnection. */
export type HostWorkspaceRoots = readonly string[] | (() => readonly string[]);

type CheckWorkspaceRoots = (roots: readonly string[]) => Promise<void>;

/**
 * Coordinates host processes and their private storage with workspace admission in one desktop host.
 * Each process holds its executable and input paths through child close. A proposed
 * workspace is visible to new launches immediately. The host interrupts conflicting
 * operations and waits for their cleanup before publishing the new workspace roots.
 */
export class HostProcessLeases {
  private readonly active = new Set<(roots: readonly string[]) => Promise<void>>();
  private readonly pending = new Set<() => readonly string[]>();

  constructor(private readonly attached: HostWorkspaceRoots) {}

  get workspaceRoots(): readonly string[] {
    const attached = typeof this.attached === 'function' ? this.attached() : this.attached;
    return [...new Set([...attached, ...[...this.pending].flatMap(roots => roots())])];
  }

  /** Register and start in the same turn as the final authority check. Release when the operation settles. */
  async run<T>(
    check: CheckWorkspaceRoots,
    signal: AbortSignal,
    launch: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const revoked = new AbortController();
    const closed = new Deferred<void>();
    const drainConflict = (roots: readonly string[]) =>
      Promise.race([
        closed.promise,
        check(roots).catch(() => {
          if (this.active.has(drainConflict))
            revoked.abort(new Error('A workspace is attaching a host process input. Retry the operation.'));
          return closed.promise;
        }),
      ]);
    this.active.add(drainConflict);
    try {
      const processSignal = AbortSignal.any([signal, revoked.signal]);
      const result = await launch(processSignal);
      processSignal.throwIfAborted();
      return result;
    } finally {
      this.active.delete(drainConflict);
      closed.resolve();
    }
  }

  /**
   * Publish synchronously when no process is running, preserving ownership ordering.
   * While draining, retain the proposal across every await, including checks repeated
   * when a logical root resolves to a different physical directory.
   */
  admitWorkspace(
    readRoots: () => readonly string[],
    publish: (paths: readonly string[]) => void,
  ): Promise<void> | void {
    if (this.active.size === 0) {
      publish(readRoots());
      return;
    }
    const observed = new Set<string>();
    const proposal = () => {
      for (const path of readRoots()) observed.add(path);
      return [...observed];
    };
    this.pending.add(proposal);
    const admit = async () => {
      try {
        for (;;) {
          const roots = proposal();
          await Promise.all([...this.active].map(drain => drain(roots)));
          if (roots.length === proposal().length) {
            publish(roots);
            return;
          }
        }
      } finally {
        this.pending.delete(proposal);
      }
    };
    return admit();
  }
}
