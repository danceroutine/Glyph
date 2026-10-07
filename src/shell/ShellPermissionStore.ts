import type { ShellPermissionPolicy } from './ShellPermissionPolicy.ts';

/** Durable project-scoped storage for shell authorization choices. */
export interface ShellPermissionStore {
  load(projectContextId: string): Promise<ShellPermissionPolicy | undefined>;
  save(policy: ShellPermissionPolicy): Promise<void>;
}
