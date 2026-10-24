import type { ApprovalCapability } from './ApprovalCapability.ts';
import type { ApprovalCapabilityPolicy, ApprovalGrantMatch } from './ApprovalCapabilityPolicy.ts';
import type { ApprovalGrant, GrantPermission } from './ApprovalGrant.ts';
import type { ApprovalRequest, WorkspaceScope } from './ApprovalRequest.ts';

/** Immutable remembered authority, unique by workspace scope and permission. */
export class ApprovalGrantSet {
  private readonly grants: readonly ApprovalGrant[];

  private constructor(records: readonly ApprovalGrant[]) {
    const grants: ApprovalGrant[] = [];
    for (const record of records) {
      const existing = grants.findIndex(
        grant =>
          ApprovalGrantSet.sameScope(grant.workspace, record.workspace) &&
          ApprovalGrantSet.samePermission(grant.permission, record.permission),
      );
      if (existing !== -1) grants.splice(existing, 1);
      grants.push(
        Object.freeze({
          ...record,
          workspace: Object.freeze({ ...record.workspace }),
          permission: Object.freeze({ ...record.permission }),
        }),
      );
    }
    this.grants = Object.freeze(grants);
  }

  /** Hydrate records without retaining mutable aliases. The last equivalent grant wins. */
  static from(records: readonly ApprovalGrant[]): ApprovalGrantSet {
    return new ApprovalGrantSet(records);
  }

  private static sameScope(left: WorkspaceScope, right: WorkspaceScope): boolean {
    return left.workspaceId === right.workspaceId && left.mutationScope === right.mutationScope;
  }

  private static samePermission(left: GrantPermission, right: GrantPermission): boolean {
    if (left.kind === 'exact_command')
      return (
        right.kind === 'exact_command' &&
        left.command === right.command &&
        left.workingDirectory === right.workingDirectory
      );
    return left.capability === right.capability && left.kind === right.kind;
  }

  /** Detached plain records for persistence; callers cannot mutate this set through them. */
  toRecords(): ApprovalGrant[] {
    return structuredClone([...this.grants]);
  }

  /** Replace equivalent authority and its provenance without changing the original set. */
  withGrant(grant: ApprovalGrant): ApprovalGrantSet {
    return ApprovalGrantSet.from([...this.grants, grant]);
  }

  permissionsFor(scope: WorkspaceScope): readonly GrantPermission[] {
    return this.grants
      .filter(grant => ApprovalGrantSet.sameScope(grant.workspace, scope))
      .map(grant => grant.permission);
  }

  /** Policies define authority and precedence; the set enforces scope and capability isolation. */
  match<C extends ApprovalCapability>(
    request: ApprovalRequest<C>,
    policy: ApprovalCapabilityPolicy<C>,
  ): { readonly grant: ApprovalGrant; readonly match: ApprovalGrantMatch<C> } | undefined {
    if (request.capability !== policy.capability) throw new Error('Approval capability does not match its policy.');
    let selected: { grant: ApprovalGrant; match: ApprovalGrantMatch<C> } | undefined;
    for (const grant of this.grants) {
      if (
        grant.permission.capability !== policy.capability ||
        !ApprovalGrantSet.sameScope(grant.workspace, request.workspace)
      )
        continue;
      const match = policy.matchGrant(request, grant.permission);
      if (match && (!selected || match.priority > selected.match.priority)) selected = { grant, match };
    }
    return selected;
  }
}
