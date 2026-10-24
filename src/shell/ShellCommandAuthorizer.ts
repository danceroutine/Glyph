import { Approval } from '#src/interaction/approvals/Approval.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import { ApprovalCoordinator } from '#src/interaction/approvals/ApprovalCoordinator.js';
import { ApprovalQueue } from '#src/interaction/approvals/ApprovalQueue.js';
import type { ApprovalGrantStore } from '#src/interaction/approvals/ApprovalGrant.js';
import { ApprovalGrantSet } from '#src/interaction/approvals/ApprovalGrantSet.js';
import type { WorkspaceScope } from '#src/interaction/approvals/ApprovalRequest.js';
import type { ShellAuthorizationContext } from './ShellAuthorizationContext.ts';
import type { ShellExecutionAuthorization } from './ShellExecutionAuthorization.ts';
import { ShellPermissionMode } from './ShellPermissionPolicy.ts';
import type { ShellPermissionPresenter } from './ShellPermissionPresenter.ts';
import type { ShellPermissionStore } from './ShellPermissionStore.ts';
import { ShellApprovalPolicy } from './ShellApprovalPolicy.ts';
import { LegacyShellApprovalStore } from './LegacyShellApprovalStore.ts';

const defaultContext: ShellAuthorizationContext = { background: false, existingTerminal: false };

/** Shell-specific authorization delegates decision lifecycle and grant admission to the domain. */
export class ShellCommandAuthorizer {
  private readonly scope: WorkspaceScope;
  private readonly grants: ApprovalGrantStore;
  private readonly policy: ShellApprovalPolicy;
  private readonly coordinator = new ApprovalCoordinator();
  private readonly queue = new ApprovalQueue();
  private currentMode = ShellPermissionMode.ASK;
  private initialized = false;
  constructor(
    scope: WorkspaceScope | string,
    store: ApprovalGrantStore | ShellPermissionStore,
    private readonly presenter: ShellPermissionPresenter,
  ) {
    this.scope = typeof scope === 'string' ? { workspaceId: scope, mutationScope: scope } : scope;
    this.grants = 'kind' in store ? store : new LegacyShellApprovalStore(store);
    this.policy = new ShellApprovalPolicy(presenter.shellPermissionChoices);
  }
  get mode(): ShellPermissionMode {
    return this.currentMode;
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.refreshMode();
    this.initialized = true;
  }
  authorize(
    command: string,
    workingDirectory: string,
    signal: AbortSignal,
    context: ShellAuthorizationContext = defaultContext,
  ): Promise<ShellExecutionAuthorization> {
    return this.queue.run(signal, async () => {
      signal.throwIfAborted();
      await this.initialize();
      signal.throwIfAborted();
      const approval = new Approval(
        this.policy.createRequest({ workspace: this.scope, operation: { command, workingDirectory, ...context } }),
      );
      const result = await this.coordinator.resolve(
        approval,
        this.policy,
        {
          presentApproval: async (pending, cancellation, displayed) => {
            displayed();
            const choiceId = await this.presenter.presentShellPermission(
              { command: pending.request.operation.command, workingDirectory, approval: pending },
              cancellation,
            );
            return { approvalId: pending.id, choiceId };
          },
        },
        signal,
        this.grants,
      );
      if (result.grantUpdate.kind === 'saved') await this.refreshMode();
      if (result.admission === 'denied') {
        const message =
          result.grantUpdate.kind === 'failed'
            ? 'The user denied this command; the safe-command preference could not be saved.'
            : 'The user denied permission to execute this shell command.';
        throw new Error(message);
      }
      if (result.admission !== 'authorized') throw result.error;
      signal.throwIfAborted();
      return { sandboxProfile: result.authorization.sandbox };
    });
  }
  private async refreshMode(): Promise<void> {
    const snapshot = await this.grants.load(this.scope);
    const permissions = ApprovalGrantSet.from(snapshot.grants).permissionsFor(this.scope);
    this.currentMode = permissions.some(
      permission => permission.capability === ApprovalCapability.SHELL && permission.kind === 'all_shell_commands',
    )
      ? ShellPermissionMode.ALLOW_EVERYTHING
      : permissions.some(
            permission => permission.capability === ApprovalCapability.SHELL && permission.kind === 'safe_inspection',
          )
        ? ShellPermissionMode.ALLOW_SAFE
        : ShellPermissionMode.ASK;
  }
}
