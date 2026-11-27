import { join } from 'node:path';
import { WorkspaceAccessPolicy } from './WorkspaceAccessPolicy.ts';
import type { StartupUserProfile } from './StartupUserProfile.ts';

/**
 * The host selects one content policy per consumer. Automatic tools and discovery exclude the startup
 * profile's personal source directories, including their mounted aliases. A deliberate attachment can
 * read its selected file under the host-private exclusions. It grants no subsequent search or tool access.
 * The user catalog verifies the selected physical profile at the start and end of each operation.
 */
export class WorkspaceContentAccess {
  /** Automatic discovery, references and project tools use this view. */
  readonly project: WorkspaceAccessPolicy;
  /**
   * The launcher passes this view to the OS sandbox. It reserves the selected profile and each
   * workspace's package staging area even when a directory will be created after process launch.
   */
  readonly shell: WorkspaceAccessPolicy;
  /** Read the exact file a human chose. Directory expansion goes through project discovery. */
  readonly selectedFile: WorkspaceAccessPolicy;
  /** Read personal rules and skills through their scoped providers against the verified startup profile. */
  readonly userCatalog: WorkspaceAccessPolicy;

  constructor(
    profile: StartupUserProfile,
    hostPrivate: () => readonly string[],
    installation: readonly string[],
    workspaceRoots: readonly string[],
  ) {
    const personal = [join(profile.path, 'rules'), join(profile.path, 'skills')];
    const projectPrivate = () => [...hostPrivate(), ...installation];
    this.project = new WorkspaceAccessPolicy({}, () => [...projectPrivate(), ...personal]);
    this.shell = new WorkspaceAccessPolicy({}, () => [
      ...hostPrivate(),
      profile.path,
      ...personal,
      ...workspaceRoots.map(root => join(root, '.skill-staging')),
      join(profile.path, '.skill-staging'),
    ]);
    this.selectedFile = new WorkspaceAccessPolicy({}, projectPrivate);
    this.userCatalog = new WorkspaceAccessPolicy({}, () => {
      profile.verify();
      return projectPrivate();
    });
  }
}
