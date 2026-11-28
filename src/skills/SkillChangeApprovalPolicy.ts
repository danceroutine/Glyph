import type { Approval, ApprovalDecision } from '#src/interaction/approvals/Approval.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import type {
  ApprovalCapabilityPolicy,
  ApprovalDecisionPlan,
} from '#src/interaction/approvals/ApprovalCapabilityPolicy.js';
import type { ApprovalRequest, ApprovalRequestInput } from '#src/interaction/approvals/ApprovalRequest.js';

/**
 * Authorizes one reviewed skill package change. The package manager binds the
 * approval to the preview and verifies the target revision, source authority
 * and editor state again at publication. Each new change needs its own approval.
 */
export class SkillChangeApprovalPolicy implements ApprovalCapabilityPolicy<ApprovalCapability.SKILL_CHANGE> {
  readonly capability = ApprovalCapability.SKILL_CHANGE;
  createRequest(
    input: ApprovalRequestInput<ApprovalCapability.SKILL_CHANGE>,
  ): ApprovalRequest<ApprovalCapability.SKILL_CHANGE> {
    return {
      ...input,
      capability: this.capability,
      title: input.operation.title,
      detail: input.operation.detail,
      timeout: null,
      choices: [
        {
          id: 'deny',
          label: 'Deny',
          description: 'Leave the skill unchanged.',
          effect: { disposition: 'deny', grant: null },
        },
        {
          id: 'allow_once',
          label: 'Allow',
          description: 'Apply this exact reviewed package revision.',
          effect: { disposition: 'allow', grant: null },
        },
      ],
    };
  }
  matchGrant(): null {
    return null;
  }
  planDecision(
    approval: Approval<ApprovalCapability.SKILL_CHANGE>,
    decision: ApprovalDecision<ApprovalCapability.SKILL_CHANGE>,
  ): ApprovalDecisionPlan<ApprovalCapability.SKILL_CHANGE> {
    return approval.effectOf(decision).disposition === 'deny'
      ? { disposition: 'deny', grant: null }
      : { disposition: 'allow', authorization: { disposition: 'allow', grant: null }, grant: null };
  }
}
