import { expect, it, vi } from 'vitest';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import type { ApprovalGrant, GrantPermission } from '#src/interaction/approvals/ApprovalGrant.js';
import { ApprovalGrantSet } from '#src/interaction/approvals/ApprovalGrantSet.js';
import { InternalWebApprovalPolicy } from '#src/web/InternalWebApprovalPolicy.js';
import { ShellApprovalPolicy } from '#src/shell/ShellApprovalPolicy.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';

const scope = { workspaceId: 'workspace', mutationScope: 'roots' };
const policy = new ShellApprovalPolicy();
const request = policy.createRequest({
  workspace: scope,
  operation: { command: 'pwd', workingDirectory: '/repo', background: false, existingTerminal: false },
});
function anApprovalGrant(overrides: Partial<ApprovalGrant> = {}): ApprovalGrant {
  return {
    id: 'grant',
    workspace: scope,
    permission: { capability: ApprovalCapability.SHELL, kind: 'safe_inspection' },
    originatingDecisionId: 'decision',
    createdAt: '2026-10-25',
    ...overrides,
  };
}

/** Replacement uses permission identity, including exact-command directories, without broadening authority. */
it('replaces equivalent permissions while preserving distinct ones and the original set', () => {
  const permissions: GrantPermission[] = [
    { capability: ApprovalCapability.SHELL, kind: 'safe_inspection' },
    { capability: ApprovalCapability.SHELL, kind: 'all_shell_commands' },
    { capability: ApprovalCapability.INTERNAL_WEB, kind: 'all_internal_web' },
    { capability: ApprovalCapability.SHELL, kind: 'exact_command', command: 'pwd', workingDirectory: '/repo' },
    { capability: ApprovalCapability.SHELL, kind: 'exact_command', command: 'ls', workingDirectory: '/repo' },
    { capability: ApprovalCapability.SHELL, kind: 'exact_command', command: 'pwd', workingDirectory: '/other' },
  ];
  for (const [leftIndex, left] of permissions.entries()) {
    const original = anApprovalGrant({ permission: left });
    const set = ApprovalGrantSet.from([original]);
    for (const [rightIndex, right] of permissions.entries()) {
      const replacement = anApprovalGrant({ id: 'new', permission: right, originatingDecisionId: 'new-decision' });
      expect(set.withGrant(replacement).toRecords()).toEqual(
        leftIndex === rightIndex ? [replacement] : [original, replacement],
      );
      expect(set.toRecords()).toEqual([original]);
    }
  }
});

/** Existing duplicate snapshots are normalized without collapsing other workspaces or roots. */
it('hydrates duplicate records with the last equivalent grant winning', () => {
  const original = anApprovalGrant();
  const otherWorkspace = anApprovalGrant({ id: 'other-workspace', workspace: { ...scope, workspaceId: 'other' } });
  const otherRoots = anApprovalGrant({ id: 'other-roots', workspace: { ...scope, mutationScope: 'other' } });
  const latest = anApprovalGrant({ id: 'latest' });
  const set = ApprovalGrantSet.from([original, otherWorkspace, otherRoots, latest]);
  expect(set.toRecords()).toEqual([otherWorkspace, otherRoots, latest]);
  expect(set.permissionsFor(scope)).toEqual([latest.permission]);
  expect(set.permissionsFor({ ...scope, workspaceId: 'missing' })).toEqual([]);
  expect(set.withGrant(latest).toRecords()).toEqual(set.toRecords());
});

/** Construction, queries, and serialization cannot expose mutable aliases into remembered authority. */
it('isolates its records from input and output mutations', () => {
  const input = {
    ...anApprovalGrant(),
    workspace: { ...scope },
    permission: {
      capability: ApprovalCapability.SHELL,
      kind: 'exact_command',
      command: 'pwd',
      workingDirectory: '/repo',
    } as const,
  };
  const expected = structuredClone(input);
  const records = [input];
  const set = ApprovalGrantSet.from(records);
  input.id = 'changed';
  input.workspace.workspaceId = 'changed';
  Object.assign(input.permission, { command: 'changed' });
  records.length = 0;
  const serialized = set.toRecords();
  expect(Object.getPrototypeOf(serialized[0])).toBe(Object.prototype);
  Object.assign(serialized[0]!.permission, { command: 'changed' });
  Object.assign(serialized[0]!.workspace, { workspaceId: 'changed' });
  serialized.length = 0;
  const permissions = set.permissionsFor(scope);
  expect(() => Object.assign(permissions[0]!, { command: 'changed' })).toThrow(TypeError);
  const selected = set.match(request, policy)!;
  expect(() => Object.assign(selected.grant, { id: 'changed' })).toThrow(TypeError);
  expect(() => Object.assign(selected.grant.workspace, { workspaceId: 'changed' })).toThrow(TypeError);
  expect(set.toRecords()).toEqual([expected]);
});

/** Only the matching scope and capability reach policy evaluation; an empty set grants nothing. */
it('isolates matching by scope and capability', () => {
  expect(ApprovalGrantSet.from([]).match(request, policy)).toBeUndefined();
  const match = vi.spyOn(policy, 'matchGrant');
  try {
    const set = ApprovalGrantSet.from([
      anApprovalGrant({ workspace: { ...scope, workspaceId: 'other' } }),
      anApprovalGrant({ workspace: { ...scope, mutationScope: 'other' } }),
      anApprovalGrant({ permission: { capability: ApprovalCapability.INTERNAL_WEB, kind: 'all_internal_web' } }),
      anApprovalGrant({
        permission: {
          capability: ApprovalCapability.SHELL,
          kind: 'exact_command',
          command: 'ls',
          workingDirectory: '/repo',
        },
      }),
    ]);
    expect(set.match(request, policy)).toBeUndefined();
    expect(match).toHaveBeenCalledExactlyOnceWith(request, expect.objectContaining({ command: 'ls' }));
  } finally {
    match.mockRestore();
  }
});

/** Policy priority wins in either order; equal priority retains the first eligible grant. */
it.each([false, true])('selects the strongest matching authority with reversed order=%s', reverse => {
  const records = [
    anApprovalGrant(),
    anApprovalGrant({
      id: 'exact',
      permission: {
        capability: ApprovalCapability.SHELL,
        kind: 'exact_command',
        command: 'pwd',
        workingDirectory: '/repo',
      },
    }),
    anApprovalGrant({ id: 'full', permission: { capability: ApprovalCapability.SHELL, kind: 'all_shell_commands' } }),
  ];
  if (reverse) records.reverse();
  const set = ApprovalGrantSet.from(records);
  expect(set.match(request, policy)).toMatchObject({
    grant: { id: 'full' },
    match: { authorization: { sandbox: ShellSandboxProfile.FULL_ACCESS } },
  });
  const equalPriority = vi.spyOn(policy, 'matchGrant').mockReturnValue({
    priority: 1,
    authorization: { disposition: 'allow', sandbox: ShellSandboxProfile.READ_ONLY, grant: null },
  });
  try {
    expect(set.match(request, policy)?.grant.id).toBe(records[0]!.id);
  } finally {
    equalPriority.mockRestore();
  }
});

/** A caller cannot apply another capability's policy to a request, even when the set is empty. */
it('rejects a mismatched capability policy', () => {
  expect(() =>
    ApprovalGrantSet.from([]).match<ApprovalCapability.SHELL | ApprovalCapability.INTERNAL_WEB>(
      request,
      new InternalWebApprovalPolicy(),
    ),
  ).toThrow('Approval capability does not match its policy.');
});
