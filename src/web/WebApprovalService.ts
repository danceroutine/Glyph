import { Approval } from '#src/interaction/approvals/Approval.js';
import { ApprovalCoordinator } from '#src/interaction/approvals/ApprovalCoordinator.js';
import { ApprovalQueue } from '#src/interaction/approvals/ApprovalQueue.js';
import type { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import type { ApprovalGrantStore } from '#src/interaction/approvals/ApprovalGrant.js';
import type { ApprovalPresenter } from '#src/interaction/approvals/ApprovalPresenter.js';
import type { WorkspaceScope } from '#src/interaction/approvals/ApprovalRequest.js';
import type { WebDestination } from './WebDestination.ts';
import { InternalWebApprovalPolicy } from './InternalWebApprovalPolicy.ts';
import { WebRequestError } from './WebRequestError.ts';

/** Binds a checked destination to a domain request; the transport owns the socket. */
export class WebApprovalService {
  private readonly queue = new ApprovalQueue();
  private readonly policy = new InternalWebApprovalPolicy();
  private readonly coordinator = new ApprovalCoordinator();
  constructor(
    private readonly scope: WorkspaceScope,
    private readonly store: ApprovalGrantStore,
    private readonly presenter: ApprovalPresenter<ApprovalCapability.INTERNAL_WEB>,
  ) {}
  request(destination: WebDestination, signal: AbortSignal): Promise<void> {
    return this.queue.run(signal, async () => {
      const approval = new Approval(
        this.policy.createRequest({
          workspace: this.scope,
          operation: {
            url: destination.url.href,
            method: 'GET',
            resolvedAddresses: destination.addresses.map(address => address.address),
          },
        }),
      );
      const result = await this.coordinator.resolve(approval, this.policy, this.presenter, signal, this.store);
      if (result.admission === 'authorized') return;
      if (result.admission === 'denied')
        throw new WebRequestError('DESTINATION_DENIED', 'The user denied internal web access.');
      throw result.error;
    });
  }
}
