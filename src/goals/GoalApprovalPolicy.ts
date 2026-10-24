import type { Approval, ApprovalDecision } from '#src/interaction/approvals/Approval.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import type {
  ApprovalCapabilityPolicy,
  ApprovalDecisionPlan,
} from '#src/interaction/approvals/ApprovalCapabilityPolicy.js';
import type { ApprovalRequest, ApprovalRequestInput } from '#src/interaction/approvals/ApprovalRequest.js';

export class GoalApprovalPolicy implements ApprovalCapabilityPolicy<ApprovalCapability.GOAL> {
  readonly capability = ApprovalCapability.GOAL;
  createRequest(input: ApprovalRequestInput<ApprovalCapability.GOAL>): ApprovalRequest<ApprovalCapability.GOAL> {
    return {
      ...input,
      capability: this.capability,
      title: 'Start a goal?',
      detail: input.operation.objective,
      timeout: null,
      choices: [
        {
          id: 'deny',
          label: 'Deny',
          description: 'Do not start this goal.',
          effect: { disposition: 'deny', grant: null },
        },
        {
          id: 'allow_once',
          label: 'Allow',
          description: 'Start this proposed goal.',
          effect: { disposition: 'allow', grant: null },
        },
      ],
    };
  }
  matchGrant(): null {
    return null;
  }
  planDecision(
    approval: Approval<ApprovalCapability.GOAL>,
    decision: ApprovalDecision<ApprovalCapability.GOAL>,
  ): ApprovalDecisionPlan<ApprovalCapability.GOAL> {
    return approval.effectOf(decision).disposition === 'deny'
      ? { disposition: 'deny', grant: null }
      : { disposition: 'allow', authorization: { disposition: 'allow', grant: null }, grant: null };
  }
}
