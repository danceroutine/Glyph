import { describe, expect, it, vi } from 'vitest';
import { ShellCommandAuthorizer } from '#src/shell/ShellCommandAuthorizer.js';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.js';
import { ShellPermissionMode } from '#src/shell/ShellPermissionPolicy.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';
import { LegacyShellApprovalStore } from '#src/shell/LegacyShellApprovalStore.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import type {
  ApprovalGrant,
  ApprovalGrantStore,
  GrantPermission,
  GrantSnapshot,
} from '#src/interaction/approvals/ApprovalGrant.js';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';

const scope = { workspaceId: 'workspace', mutationScope: 'roots' };
function grant(permission: GrantPermission): ApprovalGrant {
  return {
    id: JSON.stringify(permission),
    workspace: scope,
    permission,
    originatingDecisionId: 'decision',
    createdAt: 'now',
  };
}

describe('security: shell approval integration', () => {
  /** Deny-and-enable can never launch the current mutation; only a successfully saved preference admits later inspections. */
  it.each([false, true])('keeps current denial while handling preference save failure=%s', async fails => {
    let snapshot: GrantSnapshot = { revision: '0', grants: [] };
    const store: ApprovalGrantStore = {
      kind: 'approval_grants',
      load: async () => snapshot,
      save: async (_scope, _revision, grants) => {
        if (fails) throw new Error('quota');
        snapshot = { revision: '1', grants };
        return snapshot;
      },
    };
    const presentShellPermission = vi.fn(async () => ShellPermissionDecision.DENY_AND_ALLOW_SAFE);
    const authorizer = new ShellCommandAuthorizer(scope, store, { presentShellPermission });
    await expect(authorizer.authorize('echo changed', '/repo', new AbortController().signal)).rejects.toThrow(
      fails ? 'preference could not be saved' : 'denied',
    );
    expect(authorizer.mode).toBe(fails ? ShellPermissionMode.ASK : ShellPermissionMode.ALLOW_SAFE);
    if (!fails) {
      await expect(authorizer.authorize('pwd', '/repo', new AbortController().signal)).resolves.toEqual({
        sandboxProfile: ShellSandboxProfile.READ_ONLY,
      });
      expect(presentShellPermission).toHaveBeenCalledOnce();
      snapshot = { revision: 'revoked', grants: [] };
      await expect(authorizer.authorize('pwd', '/repo', new AbortController().signal)).rejects.toThrow('denied');
      expect(presentShellPermission).toHaveBeenCalledTimes(2);
    }
  });
  /** Compatibility imports safe mode, merges duplicate exact grants, preserves full-access precedence, and rejects invalid/stale writes. */
  it('preserves legacy store semantics without accepting another capability or stale update', async () => {
    const save = vi.fn(async () => {});
    const store = new LegacyShellApprovalStore({
      load: async () => ({
        schemaVersion: 2,
        projectContextId: 'roots',
        mode: ShellPermissionMode.ALLOW_SAFE,
        allowedCommands: [],
      }),
      save,
    });
    const imported = await store.load(scope);
    expect(imported.grants[0]?.permission.kind).toBe('safe_inspection');
    const exact = grant({
      capability: ApprovalCapability.SHELL,
      kind: 'exact_command',
      command: 'pwd',
      workingDirectory: '/repo',
    });
    const full = grant({ capability: ApprovalCapability.SHELL, kind: 'all_shell_commands' });
    const merged = await store.save(scope, imported.revision, [
      exact,
      exact,
      { ...exact, id: 'another-scope', workspace: { ...scope, workspaceId: 'other' } },
      full,
      ...imported.grants,
    ]);
    expect(save).toHaveBeenCalledExactlyOnceWith({
      schemaVersion: 2,
      projectContextId: 'roots',
      mode: ShellPermissionMode.ALLOW_EVERYTHING,
      allowedCommands: [{ command: 'pwd', workingDirectory: '/repo' }],
    });
    await expect(store.save(scope, imported.revision, [])).rejects.toThrow('changed');
    await expect(
      store.save(scope, merged.revision, [
        grant({ capability: ApprovalCapability.INTERNAL_WEB, kind: 'all_internal_web' }),
      ]),
    ).rejects.toThrow('another capability');
    expect(await store.load(scope)).toEqual(merged);
    expect(save).toHaveBeenCalledOnce();
  });
  /** A cancelled or failed goal prompt must never be treated as an ordinary affirmative answer. */
  it.each(['cancel', 'publish failure'] as const)('rejects goal presentation on %s', async phase => {
    const controller = new AbortController();
    const broker = new DesktopInteractionBroker(() => {
      if (phase === 'publish failure') throw new Error('display failed');
    });
    const pending = broker.run({ chatId: 'chat', runId: 'run' }, () =>
      broker.presentGoalProposal('Ship', controller.signal),
    );
    const rejected = expect(pending).rejects.toThrow(phase === 'cancel' ? 'stopped' : 'display failed');
    if (phase === 'cancel') controller.abort(new Error('stopped'));
    await rejected;
  });
});
