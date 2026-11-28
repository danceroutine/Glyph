import { outsideWorkspace, trustedHostExecutable, type HostExecutable } from '#src/shell/TrustedHostExecutable.js';
import { HostProcessLeases, type HostWorkspaceRoots } from './HostProcessLeases.ts';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';

export type { HostWorkspaceRoots } from './HostProcessLeases.ts';

/**
 * Binds host tools and their inputs to locations outside attached workspaces.
 * Admission retains logical and physical paths. Repository children launch through
 * run so peer workspace admission covers deferred helper invocations through
 * child close. A storage lease covers allocation through cleanup, including staged skill execution. Other
 * launchers consume the guard from validate at their handoff.
 */
export class HostExecutionAuthority {
  private readonly sockets = new Set<string>();
  private readonly paths = new Set<string>();

  private readonly processes: HostProcessLeases;
  constructor(
    workspace: HostWorkspaceRoots | HostProcessLeases,
    private readonly host: HostFilesystemAuthority,
  ) {
    this.processes = workspace instanceof HostProcessLeases ? workspace : new HostProcessLeases(workspace);
  }

  get workspaceRoots(): readonly string[] {
    return this.processes.workspaceRoots;
  }

  admit(path: string): string {
    const physical = outsideWorkspace(path, this.workspaceRoots);
    this.paths.add(path);
    this.paths.add(physical);
    return physical;
  }

  /** Admit a host authentication endpoint as a socket only, retaining its logical and physical routes. */
  admitSocket(path: string): string {
    const physical = this.admit(path);
    this.sockets.add(path);
    this.sockets.add(physical);
    return physical;
  }

  executable(name: HostExecutable): string {
    return this.admit(trustedHostExecutable(name, this.workspaceRoots));
  }

  /** Start a separate input set under the same host and live workspace authority. */
  inputs(): HostExecutionAuthority {
    return new HostExecutionAuthority(this.processes, this.host);
  }

  /** A child can admit additional inputs before a deferred helper runs. Those inputs belong to this
   * process through child close. Concurrent and subsequent commands retain their own input sets. */
  async run<T>(
    signal: AbortSignal,
    launch: (signal: AbortSignal, include: (inputs: HostExecutionAuthority) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const inputs = this.inputs();
    inputs.merge(this);
    const current = await inputs.validate();
    signal.throwIfAborted();
    current();
    return this.processes.run(
      roots => inputs.checkPaths([...inputs.paths], roots),
      signal,
      processSignal => launch(processSignal, group => inputs.include(group)),
    );
  }

  /** Verify the physical paths and return a final root check for synchronous process handoff. */
  validate(): Promise<() => void> {
    return this.guard([...this.paths]);
  }

  private async include(group: HostExecutionAuthority): Promise<void> {
    const selected = this.inputs();
    selected.merge(group);
    const current = await selected.validate();
    current();
    this.merge(selected);
  }

  private merge(group: HostExecutionAuthority): void {
    for (const path of group.paths) this.paths.add(path);
    for (const path of group.sockets) this.sockets.add(path);
  }

  private async checkPaths(paths: readonly string[], roots: readonly string[]): Promise<void> {
    for (const path of paths) outsideWorkspace(path, roots);
    // Keep large local object inventories within the native request frame. Every batch shares this root snapshot.
    if (paths.length === 0) return this.host.assertHostPaths([], roots);
    for (let start = 0; start < paths.length; start += 256) {
      const batch = paths.slice(start, start + 256);
      const sockets = batch.filter(path => this.sockets.has(path));
      if (sockets.length > 0) await this.host.assertHostPaths(batch, roots, sockets);
      else await this.host.assertHostPaths(batch, roots);
    }
  }

  private async guard(paths: readonly string[]): Promise<() => void> {
    const roots = [...this.workspaceRoots];
    await this.checkPaths(paths, roots);
    const assertCurrent = () => {
      if (roots.join('\0') !== this.workspaceRoots.join('\0'))
        throw new Error('Attached workspace authority changed while validating host execution. Retry the operation.');
    };
    assertCurrent();
    return assertCurrent;
  }
}
