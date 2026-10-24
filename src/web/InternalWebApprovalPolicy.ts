import type { Approval, ApprovalDecision } from '#src/interaction/approvals/Approval.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import type {
  ApprovalCapabilityPolicy,
  ApprovalDecisionPlan,
  ApprovalGrantMatch,
} from '#src/interaction/approvals/ApprovalCapabilityPolicy.js';
import type { GrantPermission } from '#src/interaction/approvals/ApprovalGrant.js';
import type { ApprovalRequest, ApprovalRequestInput } from '#src/interaction/approvals/ApprovalRequest.js';

export class InternalWebApprovalPolicy implements ApprovalCapabilityPolicy<ApprovalCapability.INTERNAL_WEB> {
  readonly capability = ApprovalCapability.INTERNAL_WEB;
  createRequest(
    input: ApprovalRequestInput<ApprovalCapability.INTERNAL_WEB>,
  ): ApprovalRequest<ApprovalCapability.INTERNAL_WEB> {
    return {
      ...input,
      capability: this.capability,
      title: 'Allow internal web access?',
      timeout: null,
      detail: `Glyph wants to send an HTTP GET request to:\n${input.operation.url}\n\nResolved addresses: ${input.operation.resolvedAddresses.join(', ')}\n\nThis can reach services on your computer or private network. Allow once permits only this request. Allow everything remembers internal web access for this workspace; it does not grant shell permission.`,
      choices: [
        {
          id: 'deny',
          label: 'Deny',
          description: 'Do not send this request.',
          effect: { disposition: 'deny', grant: null },
        },
        {
          id: 'allow_once',
          label: 'Allow once',
          description: 'Send only this request to its checked destination.',
          effect: { disposition: 'allow', grant: null },
        },
        {
          id: 'allow_everything',
          label: 'Allow everything',
          description: 'Remember all internal web destinations for this workspace.',
          effect: { disposition: 'allow', grant: 'all_internal_web' },
        },
      ],
    };
  }
  matchGrant(
    _request: ApprovalRequest<ApprovalCapability.INTERNAL_WEB>,
    permission: GrantPermission,
  ): ApprovalGrantMatch<ApprovalCapability.INTERNAL_WEB> | null {
    return permission.capability === this.capability
      ? { authorization: { disposition: 'allow', grant: null }, priority: 1 }
      : null;
  }
  planDecision(
    approval: Approval<ApprovalCapability.INTERNAL_WEB>,
    decision: ApprovalDecision<ApprovalCapability.INTERNAL_WEB>,
  ): ApprovalDecisionPlan<ApprovalCapability.INTERNAL_WEB> {
    const effect = approval.effectOf(decision);
    return effect.disposition === 'deny'
      ? { disposition: 'deny', grant: null }
      : {
          disposition: 'allow',
          authorization: { disposition: 'allow', grant: null },
          grant: effect.grant === null ? null : { capability: this.capability, kind: effect.grant },
        };
  }
}
