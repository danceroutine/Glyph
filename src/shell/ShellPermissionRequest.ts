import type { Approval } from '#src/interaction/approvals/Approval.js';
import type { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
export interface ShellPermissionRequest {
  readonly approval?: Approval<ApprovalCapability.SHELL>;
  readonly command: string;
  readonly workingDirectory: string;
}
