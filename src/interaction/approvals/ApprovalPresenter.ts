import type { Approval } from './Approval.ts';
import type { ApprovalCapability } from './ApprovalCapability.ts';

export interface ApprovalSelection {
  readonly approvalId: string;
  readonly choiceId: string;
}
/** The presenter reports actual display; queue time must not consume a countdown. */
export interface ApprovalPresenter<C extends ApprovalCapability> {
  presentApproval(approval: Approval<C>, signal: AbortSignal, displayed: () => void): Promise<ApprovalSelection>;
}
