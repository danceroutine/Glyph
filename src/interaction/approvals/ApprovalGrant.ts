import { ApprovalCapability } from './ApprovalCapability.ts';
import type { WorkspaceScope } from './ApprovalRequest.ts';

export type GrantPermission =
  | {
      readonly capability: ApprovalCapability.SHELL;
      readonly kind: 'exact_command';
      readonly command: string;
      readonly workingDirectory: string;
    }
  | { readonly capability: ApprovalCapability.SHELL; readonly kind: 'safe_inspection' | 'all_shell_commands' }
  | { readonly capability: ApprovalCapability.INTERNAL_WEB; readonly kind: 'all_internal_web' };
/** Plain persistence record; ApprovalGrantSet owns live collection behavior. */
export interface ApprovalGrant {
  readonly id: string;
  readonly workspace: WorkspaceScope;
  readonly permission: GrantPermission;
  readonly originatingDecisionId: string;
  readonly createdAt: string;
}
export interface GrantSnapshot {
  readonly revision: string;
  readonly grants: readonly ApprovalGrant[];
}
/** Revisions are opaque: repositories may use a counter or a content digest. */
export interface ApprovalGrantStore {
  readonly kind: 'approval_grants';
  load(scope: WorkspaceScope): Promise<GrantSnapshot>;
  save(scope: WorkspaceScope, expectedRevision: string, grants: readonly ApprovalGrant[]): Promise<GrantSnapshot>;
}
