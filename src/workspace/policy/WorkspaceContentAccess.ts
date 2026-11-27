import { join } from 'node:path';
import { WorkspaceAccessPolicy } from './WorkspaceAccessPolicy.ts';
import type { StartupUserProfile } from './StartupUserProfile.ts';

/**
 * The host selects one content policy per consumer. Automatic tools and discovery exclude the startup
 * profile's personal source directories, including their mounted aliases. A deliberate attachment can
 * read its selected file under the host-private exclusions. It grants no subsequent search or tool access.
 * All views verify the physical profile when issuing authority and when releasing an operation result.
 */
export class WorkspaceContentAccess {
  /** Automatic discovery, references and project tools use this view. */
  readonly project: WorkspaceAccessPolicy;
  /** The sandbox launcher projects these reservations into its OS process profile. */
  readonly shell: WorkspaceAccessPolicy;
  /** Read the exact file a human chose. Directory expansion goes through project discovery. */
  readonly selectedFile: WorkspaceAccessPolicy;
  /** Read personal rules and skills through their scoped providers against the verified startup profile. */
  readonly userCatalog: WorkspaceAccessPolicy;

  constructor(profile: StartupUserProfile, hostPrivate: () => readonly string[], installation: readonly string[]) {
    const personal = [join(profile.path, 'rules'), join(profile.path, 'skills')];
    const projectPrivate = () => [...hostPrivate(), ...installation];
    const verifyProfile = () => profile.verify();
    this.project = new WorkspaceAccessPolicy({}, () => [...projectPrivate(), ...personal], verifyProfile);
    this.shell = new WorkspaceAccessPolicy(
      {},
      () => [...hostPrivate(), ...personal, join(profile.path, '.skill-staging')],
      verifyProfile,
    );
    this.selectedFile = new WorkspaceAccessPolicy({}, projectPrivate, verifyProfile);
    this.userCatalog = new WorkspaceAccessPolicy({}, projectPrivate, verifyProfile);
  }
}
