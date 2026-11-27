import fs from 'node:fs';
import { dirname } from 'node:path';
import type { FilesystemNamePolicy, ReadDirectoryNamePolicies } from './FilesystemNamePolicy.ts';

/** macOS publishes one filename policy per volume. Linux can configure folding per directory. */
export class DirectoryNamePolicies {
  private readonly policies = new Map<string, FilesystemNamePolicy>();
  private readonly identities = new Map<string, string>();

  constructor(
    private readonly read: ReadDirectoryNamePolicies,
    private readonly perVolume = process.platform === 'darwin',
  ) {}

  remember(directory: string, policy: FilesystemNamePolicy): void {
    // A root can disappear between admission and construction. Its old policy never describes the parent volume.
    if (fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory())
      this.policies.set(this.identity(directory), policy);
  }

  prepare(directories: Iterable<string>): void {
    const missing = new Map<string, string>();
    for (const directory of directories) {
      const id = this.identity(directory);
      if (!this.policies.has(id)) missing.set(id, directory);
    }
    if (missing.size === 0) return;
    const result = this.read([...missing.values()]);
    let i = 0;
    for (const id of missing.keys()) this.policies.set(id, result[i++]!);
  }

  get(directory: string): FilesystemNamePolicy {
    const id = this.identity(directory);
    if (!this.policies.has(id)) this.prepare([directory]);
    return this.policies.get(id)!;
  }

  private identity(directory: string): string {
    const cached = this.identities.get(directory);
    if (cached !== undefined) return cached;
    const info = fs.statSync(directory, { bigint: true, throwIfNoEntry: false });
    // A prospective child uses the nearest directory on which a create would operate.
    let id: string;
    if (!info?.isDirectory()) id = this.identity(dirname(directory));
    else if (this.perVolume) {
      const parent = dirname(directory);
      const parentId = parent === directory ? '' : this.identity(parent);
      const device = info.dev + ':';
      // A different volume may later reuse this device number. The mounted directory pins this observation.
      id = parentId.startsWith(device) ? parentId : device + info.ino + ':' + info.birthtimeNs;
    } else id = [info.dev, info.ino, info.ctimeNs].join(':');
    if (this.identities.size === 0)
      queueMicrotask(() => {
        this.identities.clear();
        // Bound retained metadata even in a long-running host watching highly active directory trees.
        if (this.policies.size > 32_768) this.policies.clear();
      });
    this.identities.set(directory, id);
    return id;
  }
}
