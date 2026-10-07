import type { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.ts';
import type { ShellPermissionRequest as Permission } from '#src/shell/ShellPermissionRequest.ts';

/** Renderer-owned shell authorization interaction consumed by the wired panel. */
export interface TerminalShellPermissionRequest {
  readonly id: number;
  readonly permission: Permission;
  readonly complete: (decision: ShellPermissionDecision) => void;
  readonly interrupt: () => void;
}
