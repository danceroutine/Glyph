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
  readonly project: WorkspaceAccessPolicy;
  readonly shell: WorkspaceAccessPolicy;
  readonly selectedFile: WorkspaceAccessPolicy;
  readonly userCatalog: WorkspaceAccessPolicy;

  constructor(profile: StartupUserProfile, hostPrivate: () => readonly string[], installation: readonly string[]) {
    const personal = [join(profile.path, 'rules'), join(profile.path, 'skills')];
    const projectPrivate = () => [...hostPrivate(), ...installation];
    this.project = new WorkspaceAccessPolicy({}, () => [...projectPrivate(), ...personal]);
    this.shell = new WorkspaceAccessPolicy({}, () => [
      ...hostPrivate(),
      ...personal,
      join(profile.path, '.skill-staging'),
    ]);
    this.selectedFile = new WorkspaceAccessPolicy({}, projectPrivate);
    this.userCatalog = new WorkspaceAccessPolicy({}, () => {
      profile.verify();
      return projectPrivate();
    });
  }
}
