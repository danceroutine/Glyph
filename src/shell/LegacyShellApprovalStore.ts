import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import { ApprovalGrantSet } from '#src/interaction/approvals/ApprovalGrantSet.js';
import type {
  ApprovalGrant,
  ApprovalGrantStore,
  GrantPermission,
  GrantSnapshot,
} from '#src/interaction/approvals/ApprovalGrant.js';
import type { WorkspaceScope } from '#src/interaction/approvals/ApprovalRequest.js';
import { ShellPermissionMode, type ShellPermissionPolicy } from './ShellPermissionPolicy.ts';
import type { ShellPermissionStore } from './ShellPermissionStore.ts';

/** Compatibility for callers supplying the old store port; production uses FileApprovalStore. */
export class LegacyShellApprovalStore implements ApprovalGrantStore {
  readonly kind = 'approval_grants';
  private snapshot: GrantSnapshot | undefined;
  constructor(private readonly legacy: ShellPermissionStore) {}
  async load(scope: WorkspaceScope): Promise<GrantSnapshot> {
    if (this.snapshot) return this.snapshot;
    const policy = await this.legacy.load(scope.mutationScope);
    const permissions: GrantPermission[] = [];
    if (policy) {
      if (policy.mode === ShellPermissionMode.ALLOW_EVERYTHING)
        permissions.push({ capability: ApprovalCapability.SHELL, kind: 'all_shell_commands' });
      for (const grant of policy.allowedCommands)
        permissions.push({ capability: ApprovalCapability.SHELL, kind: 'exact_command', ...grant });
      if (policy.mode === ShellPermissionMode.ALLOW_SAFE)
        permissions.push({ capability: ApprovalCapability.SHELL, kind: 'safe_inspection' });
    }
    this.snapshot = {
      revision: '0',
      grants: permissions.map((permission, index) => ({
        id: `legacy-${index}`,
        workspace: scope,
        permission,
        originatingDecisionId: 'legacy-import',
        createdAt: '1970-01-01T00:00:00.000Z',
      })),
    };
    return this.snapshot;
  }
  async save(
    scope: WorkspaceScope,
    expectedRevision: string,
    grants: readonly ApprovalGrant[],
  ): Promise<GrantSnapshot> {
    const current = await this.load(scope);
    if (current.revision !== expectedRevision) throw new Error('Approval grants changed; request a fresh decision.');
    const records = ApprovalGrantSet.from(grants).toRecords();
    const commands: ShellPermissionPolicy['allowedCommands'][number][] = [];
    let mode = ShellPermissionMode.ASK;
    for (const { permission } of records) {
      if (permission.capability !== ApprovalCapability.SHELL)
        throw new Error('The legacy shell store cannot save another capability.');
      if (permission.kind === 'exact_command') {
        // Legacy command records omit scope, so projection can collapse distinct scoped grants.
        if (
          !commands.some(
            command =>
              command.command === permission.command && command.workingDirectory === permission.workingDirectory,
          )
        )
          commands.push({ command: permission.command, workingDirectory: permission.workingDirectory });
      } else if (permission.kind === 'all_shell_commands') mode = ShellPermissionMode.ALLOW_EVERYTHING;
      else if (mode !== ShellPermissionMode.ALLOW_EVERYTHING) mode = ShellPermissionMode.ALLOW_SAFE;
    }
    await this.legacy.save({
      schemaVersion: 2,
      projectContextId: scope.mutationScope,
      mode,
      allowedCommands: commands,
    });
    this.snapshot = { revision: String(Number(current.revision) + 1), grants: records };
    return this.snapshot;
  }
}
