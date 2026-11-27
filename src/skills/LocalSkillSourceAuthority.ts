import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { optionalStat } from './SkillPackageStorage.ts';
import type { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';
import type { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import type { SkillSourceAccess, PendingSkillSourceAccess } from './SkillPackageDraft.ts';

type Origin = { readonly identity: string; readonly origin: string };
type Metadata = Pick<NativeFilesystemMetadata, 'sourceOrigins' | 'assertUnlinkedDirectory'>;
const changed = () => new Error('The local skill source location changed. Preview the source again.');

/**
 * Binds a user-selected package to the route that supplied its captured bytes. A pending preview holds one directory
 * descriptor until its owner applies, discards or disposes it. Each application rechecks the live route and host
 * exclusions. A fully unlinked source can still publish the reviewed bytes if its original parent route is intact.
 */
export class LocalSkillSourceAuthority implements SkillSourceAccess {
  private constructor(
    private readonly metadata: Metadata,
    private readonly policy: WorkspaceAccessPolicy,
    private readonly root: string,
    private readonly directories: readonly Origin[],
    private readonly paths: readonly string[],
    private readonly files: readonly Origin[],
    private readonly checkPrivate: () => Promise<void>,
  ) {}

  static async capture(
    metadata: Metadata,
    policy: WorkspaceAccessPolicy,
    root: string,
    directories: readonly Origin[],
    reads: ReadonlyMap<string, string>,
    checkPrivate: () => Promise<void>,
    signal?: AbortSignal,
  ) {
    const paths = [...reads.keys()];
    const files = await metadata.sourceOrigins(paths, policy.privatePaths, signal);
    if (files.some((file, index) => file.identity !== reads.get(paths[index]!))) throw changed();
    const source = new LocalSkillSourceAuthority(metadata, policy, root, directories, paths, files, checkPrivate);
    await source.verify();
    return source;
  }

  async retain(): Promise<PendingSkillSourceAccess> {
    await this.verify();
    const descriptor = openSync(this.root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const stat = fstatSync(descriptor, { bigint: true });
    if (`${stat.dev}:${stat.ino}` !== this.directories[1]!.identity) {
      closeSync(descriptor);
      throw changed();
    }
    return {
      assertCurrent: () => this.verify(descriptor),
      release: () => {
        closeSync(descriptor);
      },
    };
  }

  private async verify(descriptor?: number): Promise<void> {
    await this.checkPrivate();
    const parent = dirname(this.root);
    if (!(await optionalStat(this.root))) {
      if (descriptor === undefined) throw changed();
      await this.metadata.assertUnlinkedDirectory(descriptor);
      const [route] = await this.metadata.sourceOrigins([parent], this.policy.privatePaths, undefined, true);
      if (route!.origin !== this.directories[0]!.origin || (await optionalStat(this.root))) throw changed();
    } else {
      const dirs = await this.metadata.sourceOrigins([parent, this.root], this.policy.privatePaths, undefined, true);
      if (dirs.some((dir, index) => dir.origin !== this.directories[index]!.origin)) throw changed();
      const current = await this.metadata.sourceOrigins(this.paths, this.policy.privatePaths);
      if (current.some((file, index) => file.origin !== this.files[index]!.origin)) throw changed();
    }
    await this.checkPrivate();
  }
}
