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

  executable(name: HostExecutable): string {
    return this.admit(trustedHostExecutable(name, this.workspaceRoots));
  }

  /** Enable an optional transport only when its installation has independent native authority. */
  async optionalExecutable(name: HostExecutable): Promise<string | undefined> {
    try {
      const path = trustedHostExecutable(name, this.workspaceRoots);
      await this.checkPaths([path], this.workspaceRoots);
      return this.admit(path);
    } catch {
      return undefined;
    }
  }

  /** Reauthorize at handoff. The operation settles after its child closes or its temporary store is removed. */
  async run<T>(signal: AbortSignal, launch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const paths = [...this.paths];
    const assertCurrent = await this.guard(paths);
    signal.throwIfAborted();
    assertCurrent();
    return this.processes.run(roots => this.checkPaths(paths, roots), signal, launch);
  }

  /** Verify the physical paths and return a final root check for synchronous process handoff. */
  validate(): Promise<() => void> {
    return this.guard([...this.paths]);
  }

  private async checkPaths(paths: readonly string[], roots: readonly string[]): Promise<void> {
    for (const path of paths) outsideWorkspace(path, roots);
    await this.host.assertHostPaths(paths, roots);
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
