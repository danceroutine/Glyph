import type { Approval, ApprovalDecision } from './Approval.ts';
import type { ApprovalCapability } from './ApprovalCapability.ts';
import type { GrantPermission } from './ApprovalGrant.ts';
import type { ApprovalRequest, ApprovalRequestInput, AuthorizedEffect } from './ApprovalRequest.ts';

export type ApprovalDecisionPlan<C extends ApprovalCapability> =
  | { readonly disposition: 'deny'; readonly grant: Extract<GrantPermission, { capability: C }> | null }
  | {
      readonly disposition: 'allow';
      readonly authorization: AuthorizedEffect<C>;
      readonly grant: Extract<GrantPermission, { capability: C }> | null;
    };
export interface ApprovalGrantMatch<C extends ApprovalCapability> {
  readonly authorization: AuthorizedEffect<C>;
  readonly priority: number;
}
/** Pure capability rules. No prompting, storage, timers or operation execution. */
export interface ApprovalCapabilityPolicy<C extends ApprovalCapability> {
  readonly capability: C;
  createRequest(input: ApprovalRequestInput<C>): ApprovalRequest<C>;
  matchGrant(request: ApprovalRequest<C>, permission: GrantPermission): ApprovalGrantMatch<C> | null;
  planDecision(approval: Approval<C>, decision: ApprovalDecision<C>): ApprovalDecisionPlan<C>;
}
