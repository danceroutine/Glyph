import { AgentMode } from '#src/chat/AgentMode.js';
import type { Approval, ApprovalDecision } from '#src/interaction/approvals/Approval.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import type {
  ApprovalCapabilityPolicy,
  ApprovalDecisionPlan,
} from '#src/interaction/approvals/ApprovalCapabilityPolicy.js';
import type { ApprovalRequest, ApprovalRequestInput } from '#src/interaction/approvals/ApprovalRequest.js';

export class ModeSwitchApprovalPolicy implements ApprovalCapabilityPolicy<ApprovalCapability.MODE_SWITCH> {
  readonly capability = ApprovalCapability.MODE_SWITCH;
  constructor(private readonly settings: { readonly autoApprove: boolean; readonly timeoutSeconds: number }) {}
  createRequest(
    input: ApprovalRequestInput<ApprovalCapability.MODE_SWITCH>,
  ): ApprovalRequest<ApprovalCapability.MODE_SWITCH> {
    return {
      ...input,
      capability: this.capability,
      title: `Switch to ${AgentMode.resolve(input.operation.target).title}`,
      detail: input.operation.explanation,
      timeout: {
        afterMilliseconds: this.settings.timeoutSeconds * 1000,
        choiceId: this.settings.autoApprove ? 'allow_once' : 'deny',
      },
      choices: [
        {
          id: 'deny',
          label: 'Deny',
          description: 'Keep the current mode.',
          effect: { disposition: 'deny', grant: null },
        },
        {
          id: 'allow_once',
          label: 'Allow',
          description: 'Apply this mode change.',
          effect: { disposition: 'allow', grant: null },
        },
      ],
    };
  }
  matchGrant(): null {
    return null;
  }
  planDecision(
    approval: Approval<ApprovalCapability.MODE_SWITCH>,
    decision: ApprovalDecision<ApprovalCapability.MODE_SWITCH>,
  ): ApprovalDecisionPlan<ApprovalCapability.MODE_SWITCH> {
    return approval.effectOf(decision).disposition === 'deny'
      ? { disposition: 'deny', grant: null }
      : { disposition: 'allow', authorization: { disposition: 'allow', grant: null }, grant: null };
  }
}
