import type { Approval, ApprovalDecision } from '#src/interaction/approvals/Approval.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import type {
  ApprovalCapabilityPolicy,
  ApprovalDecisionPlan,
  ApprovalGrantMatch,
} from '#src/interaction/approvals/ApprovalCapabilityPolicy.js';
import type { GrantPermission } from '#src/interaction/approvals/ApprovalGrant.js';
import type {
  ApprovalChoice,
  ApprovalRequest,
  ApprovalRequestInput,
} from '#src/interaction/approvals/ApprovalRequest.js';
import { ShellPermissionDecision } from './ShellPermissionDecision.ts';
import { ShellSandboxProfile } from './ShellSandboxProfile.ts';
import { isSafeShellCommand } from './isSafeShellCommand.ts';

export class ShellApprovalPolicy implements ApprovalCapabilityPolicy<ApprovalCapability.SHELL> {
  readonly capability = ApprovalCapability.SHELL;
  constructor(private readonly availableChoices: readonly string[] = Object.values(ShellPermissionDecision)) {}
  createRequest(input: ApprovalRequestInput<ApprovalCapability.SHELL>): ApprovalRequest<ApprovalCapability.SHELL> {
    const command = input.operation.command.trim();
    if (!command) throw new Error('Shell command cannot be empty.');
    const operation = { ...input.operation, command };
    const safe = this.isInspection(operation);
    const choices: ApprovalChoice<ApprovalCapability.SHELL>[] = [
      {
        id: ShellPermissionDecision.ALLOW_ONCE,
        label: 'Allow once',
        description: 'Run this command in the workspace-write sandbox.',
        effect: { disposition: 'allow', sandbox: ShellSandboxProfile.WORKSPACE_WRITE, grant: null },
      },
      {
        id: ShellPermissionDecision.ALWAYS_ALLOW,
        label: 'Always allow this command',
        description: 'Remember this exact command and directory; keep it sandboxed.',
        effect: { disposition: 'allow', sandbox: ShellSandboxProfile.WORKSPACE_WRITE, grant: 'exact_command' },
      },
      {
        id: ShellPermissionDecision.ALLOW_SAFE,
        label: 'Allow & enable safe commands',
        description: `Run this command ${safe ? 'read-only' : 'in the workspace-write sandbox'}; automatically allow future recognized inspections read-only.`,
        effect: {
          disposition: 'allow',
          sandbox: safe ? ShellSandboxProfile.READ_ONLY : ShellSandboxProfile.WORKSPACE_WRITE,
          grant: 'safe_inspection',
        },
      },
      {
        id: ShellPermissionDecision.ALLOW_OUTSIDE_SANDBOX_ONCE,
        label: 'Allow outside sandbox once',
        description: 'Run once with your full user permissions and environment.',
        effect: { disposition: 'allow', sandbox: ShellSandboxProfile.FULL_ACCESS, grant: null },
      },
      {
        id: ShellPermissionDecision.ALLOW_EVERYTHING,
        label: 'Allow everything',
        description: 'Remember unsandboxed shell access for this workspace.',
        effect: { disposition: 'allow', sandbox: ShellSandboxProfile.FULL_ACCESS, grant: 'all_shell_commands' },
      },
      {
        id: ShellPermissionDecision.DENY,
        label: 'Deny',
        description: 'Do not run this command.',
        effect: { disposition: 'deny', grant: null },
      },
      {
        id: ShellPermissionDecision.DENY_AND_ALLOW_SAFE,
        label: 'Deny & enable safe commands',
        description: 'Do not run this command; automatically allow future recognized inspections read-only.',
        effect: { disposition: 'deny', grant: 'safe_inspection' },
      },
    ];
    return {
      ...input,
      operation,
      capability: this.capability,
      title: 'Allow shell command?',
      detail: `${command}\nWorking directory: ${operation.workingDirectory}`,
      timeout: null,
      choices: choices.filter(choice => this.availableChoices.includes(choice.id)),
    };
  }
  matchGrant(
    request: ApprovalRequest<ApprovalCapability.SHELL>,
    permission: GrantPermission,
  ): ApprovalGrantMatch<ApprovalCapability.SHELL> | null {
    if (permission.capability !== this.capability) return null;
    switch (permission.kind) {
      case 'all_shell_commands':
        return {
          authorization: { disposition: 'allow', sandbox: ShellSandboxProfile.FULL_ACCESS, grant: null },
          priority: 3,
        };
      case 'exact_command':
        return permission.command === request.operation.command &&
          permission.workingDirectory === request.operation.workingDirectory
          ? {
              authorization: { disposition: 'allow', sandbox: ShellSandboxProfile.WORKSPACE_WRITE, grant: null },
              priority: 2,
            }
          : null;
      case 'safe_inspection':
        return this.isInspection(request.operation)
          ? {
              authorization: { disposition: 'allow', sandbox: ShellSandboxProfile.READ_ONLY, grant: null },
              priority: 1,
            }
          : null;
    }
  }
  planDecision(
    approval: Approval<ApprovalCapability.SHELL>,
    decision: ApprovalDecision<ApprovalCapability.SHELL>,
  ): ApprovalDecisionPlan<ApprovalCapability.SHELL> {
    const effect = approval.effectOf(decision);
    const grant: Extract<GrantPermission, { capability: ApprovalCapability.SHELL }> | null =
      effect.grant === null
        ? null
        : effect.grant === 'exact_command'
          ? {
              capability: this.capability,
              kind: effect.grant,
              command: approval.request.operation.command,
              workingDirectory: approval.request.operation.workingDirectory,
            }
          : { capability: this.capability, kind: effect.grant };
    return effect.disposition === 'deny'
      ? { disposition: 'deny', grant }
      : { disposition: 'allow', authorization: { disposition: 'allow', sandbox: effect.sandbox, grant: null }, grant };
  }
  private isInspection(operation: ApprovalRequest<ApprovalCapability.SHELL>['operation']): boolean {
    return !operation.background && !operation.existingTerminal && isSafeShellCommand(operation.command);
  }
}
