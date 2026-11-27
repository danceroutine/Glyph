import { outsideWorkspace, trustedHostExecutable, type HostExecutable } from '#src/shell/TrustedHostExecutable.js';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';

/** Current attached roots, including peer windows and roots retained during reconnection. */
export type HostWorkspaceRoots = readonly string[] | (() => readonly string[]);

/** Retains host-only locations and rechecks them against changing workspace authority before each subprocess. */
export class HostExecutionAuthority {
  private readonly paths = new Set<string>();

  constructor(
    private readonly roots: HostWorkspaceRoots,
    private readonly host: HostFilesystemAuthority,
  ) {}

  get workspaceRoots(): readonly string[] {
    return typeof this.roots === 'function' ? this.roots() : this.roots;
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

  async validate(): Promise<void> {
    const roots = [...this.workspaceRoots];
    for (const path of this.paths) outsideWorkspace(path, roots);
    await this.host.assertHostPaths([...this.paths], roots);
    if (roots.join('\0') !== this.workspaceRoots.join('\0'))
      throw new Error('Attached workspace authority changed while validating host execution. Retry the preview.');
  }
}
