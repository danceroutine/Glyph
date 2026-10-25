import type { ShellPermissionDecision } from './ShellPermissionDecision.ts';
import type { ShellPermissionRequest } from './ShellPermissionRequest.ts';

/** Host boundary for command authorization, independent of any terminal or IDE presentation. */
export interface ShellPermissionPresenter {
  readonly shellPermissionChoices?: readonly ShellPermissionDecision[];
  presentShellPermission(request: ShellPermissionRequest, signal: AbortSignal): Promise<ShellPermissionDecision>;
}
