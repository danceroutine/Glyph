import type { ShellPermissionDecision } from './ShellPermissionDecision.ts';
import type { ShellPermissionRequest } from './ShellPermissionRequest.ts';

/** Host boundary for command authorization, independent of any terminal or IDE presentation. */
export interface ShellPermissionPresenter {
  presentShellPermission(request: ShellPermissionRequest, signal: AbortSignal): Promise<ShellPermissionDecision>;
}
