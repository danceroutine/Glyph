import { describe, expect, it, vi, afterEach } from 'vitest';
import { Approval } from '#src/interaction/approvals/Approval.js';
import { ApprovalCapability } from '#src/interaction/approvals/ApprovalCapability.js';
import { ApprovalCoordinator } from '#src/interaction/approvals/ApprovalCoordinator.js';
import type { ApprovalGrant, ApprovalGrantStore, GrantSnapshot } from '#src/interaction/approvals/ApprovalGrant.js';
import type { ApprovalPresenter } from '#src/interaction/approvals/ApprovalPresenter.js';
import { ApprovalQueue } from '#src/interaction/approvals/ApprovalQueue.js';
import { QuestionApprovalPresenter } from '#src/interaction/approvals/QuestionApprovalPresenter.js';
import { InternalWebApprovalPolicy } from '#src/web/InternalWebApprovalPolicy.js';
import { WebApprovalService } from '#src/web/WebApprovalService.js';
import { WebDestination } from '#src/web/WebDestination.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import type { QuestionFormResult } from '#src/interaction/questions/QuestionFormResult.js';
import { ShellApprovalPolicy } from '#src/shell/ShellApprovalPolicy.js';
import { ShellPermissionDecision } from '#src/shell/ShellPermissionDecision.js';
import { ShellSandboxProfile } from '#src/shell/ShellSandboxProfile.js';
import { GoalApprovalPolicy } from '#src/goals/GoalApprovalPolicy.js';
import { ModeSwitchApprovalPolicy } from '#src/interaction/modes/ModeSwitchApprovalPolicy.js';
import { AgentModeID } from '#src/chat/AgentMode.js';

const scope = { workspaceId: 'workspace-one', mutationScope: 'roots-one' };
const signal = () => new AbortController().signal;
const webPolicy = new InternalWebApprovalPolicy();
const request = () =>
  webPolicy.createRequest({
    workspace: scope,
    operation: { url: 'http://internal.test/private?q=fixture', method: 'GET', resolvedAddresses: ['127.0.0.1'] },
  });
function fixture(choiceId = 'allow_once') {
  let snapshot: GrantSnapshot = { revision: '0', grants: [] };
  const store = {
    kind: 'approval_grants' as const,
    load: vi.fn<ApprovalGrantStore['load']>(async () => snapshot),
    save: vi.fn<ApprovalGrantStore['save']>(async (_scope, _revision, grants) => {
      snapshot = { revision: String(Number(snapshot.revision) + 1), grants };
      return snapshot;
    }),
  };
  const presenter = {
    presentApproval: vi.fn<ApprovalPresenter<ApprovalCapability.INTERNAL_WEB>['presentApproval']>(
      async (approval, _signal, displayed) => {
        displayed();
        return { approvalId: approval.id, choiceId };
      },
    ),
  };
  const coordinator = new ApprovalCoordinator();
  return {
    store,
    presenter,
    coordinator,
    resolve: (cancellation = signal()) =>
      coordinator.resolve(new Approval(request()), webPolicy, presenter, cancellation, store),
    revoke: () => {
      snapshot = { revision: 'revoked', grants: [] };
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('security: approval entity and admission', () => {
  /** A displayed choice settles only its own immutable request, once. Replays and invented choices never authorize. */
  it('freezes the request and decision and rejects invalid lifecycle transitions', () => {
    const input = request();
    const approval = new Approval(input);
    expect(approval.state.kind).toBe('queued');
    expect(approval.request).not.toBe(input);
    expect(Object.isFrozen(approval.request.operation.resolvedAddresses)).toBe(true);
    expect(() => approval.select('allow_once', 'user')).toThrow('not been displayed');
    expect(() => approval.effectOf({} as never)).toThrow('does not belong');
    approval.markDisplayed();
    expect(() => {
      approval.markDisplayed();
    }).toThrow('already displayed');
    expect(() => approval.select('invented', 'user')).toThrow('not available');
    expect(() => approval.select('allow_once', 'timeout_policy')).toThrow('timeout');
    const decision = approval.select('allow_once', 'user');
    expect(decision).toMatchObject({ approvalId: approval.id, origin: { kind: 'user' } });
    expect(Object.isFrozen(decision.effect)).toBe(true);
    expect(approval.effectOf(decision)).toEqual({ disposition: 'allow', grant: null });
    expect(() => approval.select('deny', 'user')).toThrow('already settled');
    expect(() => {
      approval.cancel('late');
    }).toThrow('already settled');
    const failed = new Approval(request());
    failed.fail('broken');
    expect(failed.state).toEqual({ kind: 'failed', reason: 'broken' });
    expect(() => new Approval({ ...request(), choices: [] })).toThrow('nonempty');
    expect(() => new Approval({ ...request(), choices: [request().choices[0]!, request().choices[0]!] })).toThrow(
      'unique',
    );
  });
  /** Once is transient, persistent authority is reread, and revocation must take effect on the next admission. */
  it('persists broad consent before reuse and observes revocation', async () => {
    const f = fixture();
    await f.resolve();
    await f.resolve();
    expect(f.presenter.presentApproval).toHaveBeenCalledTimes(2);
    expect(f.store.save).not.toHaveBeenCalled();
    f.presenter.presentApproval.mockImplementation(async (approval, _signal, displayed) => {
      displayed();
      return { approvalId: approval.id, choiceId: 'allow_everything' };
    });
    const saved = await f.resolve();
    expect(saved.grantUpdate.kind).toBe('saved');
    const reused = await f.resolve();
    expect(reused.decision?.origin).toMatchObject({ kind: 'existing_grant', grantRevision: '1' });
    expect(f.presenter.presentApproval).toHaveBeenCalledTimes(3);
    f.revoke();
    await f.resolve();
    expect(f.presenter.presentApproval).toHaveBeenCalledTimes(4);
  });
  /** A failed write never admits an allow; explicit denial remains denial. Neither can poison the next request. */
  it('records denial and failed persistence independently', async () => {
    const f = fixture('deny');
    expect((await f.resolve()).admission).toBe('denied');
    const broad = fixture('allow_everything');
    broad.store.save.mockRejectedValueOnce(new Error('quota'));
    expect(await broad.resolve()).toMatchObject({
      admission: 'failed',
      grantUpdate: { kind: 'failed' },
      decision: { origin: { kind: 'user' } },
    });
    expect((await broad.resolve()).admission).toBe('authorized');
    expect(broad.presenter.presentApproval).toHaveBeenCalledTimes(2);
    const approval = new Approval(request());
    expect(await broad.coordinator.resolve(approval, webPolicy, broad.presenter, signal())).toMatchObject({
      admission: 'failed',
      error: expect.objectContaining({ message: 'This approval has no grant repository.' }),
    });
  });
  /** Cancellation suppresses execution at every await boundary; an already committed preference remains truthfully reported. */
  it.each(['queued', 'load', 'present', 'save'] as const)('checks cancellation after %s', async phase => {
    const f = fixture('allow_everything');
    const cancellation = new AbortController();
    const stop = () => {
      cancellation.abort(new Error('cancelled'));
    };
    if (phase === 'queued') stop();
    if (phase === 'load')
      f.store.load.mockImplementationOnce(async () => {
        stop();
        return { revision: '0', grants: [] };
      });
    if (phase === 'present')
      f.presenter.presentApproval.mockImplementationOnce(async (approval, _signal, displayed) => {
        displayed();
        stop();
        return { approvalId: approval.id, choiceId: 'allow_everything' };
      });
    if (phase === 'save')
      f.store.save.mockImplementationOnce(async (_scope, _revision, grants) => {
        stop();
        return { revision: '1', grants };
      });
    expect(await f.resolve(cancellation.signal)).toMatchObject({
      admission: 'cancelled',
      grantUpdate: { kind: phase === 'save' ? 'saved' : 'not_requested' },
    });
    expect(f.store.save).toHaveBeenCalledTimes(phase === 'save' ? 1 : 0);
  });
  /** Scope and capability checks precede matching. A web grant cannot authorize shell or a changed workspace. */
  it('ignores unrelated grants and rejects mismatched answers and policy', async () => {
    const f = fixture();
    const grant: ApprovalGrant = {
      id: 'g',
      workspace: scope,
      permission: { capability: ApprovalCapability.INTERNAL_WEB, kind: 'all_internal_web' },
      originatingDecisionId: 'd',
      createdAt: 'now',
    };
    f.store.load.mockResolvedValue({
      revision: '1',
      grants: [
        { ...grant, workspace: { ...scope, workspaceId: 'other' } },
        { ...grant, workspace: { ...scope, mutationScope: 'other' } },
        { ...grant, permission: { capability: ApprovalCapability.SHELL, kind: 'all_shell_commands' } },
      ],
    });
    expect((await f.resolve()).decision?.origin.kind).toBe('user');
    f.presenter.presentApproval.mockImplementationOnce(async (approval, _signal, displayed) => {
      displayed();
      return { approvalId: 'other', choiceId: approval.request.choices[0]!.id };
    });
    expect(await f.resolve()).toMatchObject({
      admission: 'failed',
      error: expect.objectContaining({ message: 'The answer belongs to a different approval.' }),
    });
    f.presenter.presentApproval.mockRejectedValueOnce('transport disappeared');
    const entity = new Approval(request());
    await f.coordinator.resolve(entity, webPolicy, f.presenter, signal());
    expect(entity.state).toEqual({ kind: 'failed', reason: 'transport disappeared' });
    expect(
      (await f.coordinator.resolve(new Approval(request()), new GoalApprovalPolicy() as never, f.presenter, signal()))
        .admission,
    ).toBe('failed');
  });
  /** Internal consent names the exact request and addresses. A failed/denied decision sends no transport request. */
  it('presents complete web details and propagates denial and presenter failures', async () => {
    const f = fixture();
    const service = new WebApprovalService(scope, f.store, f.presenter);
    const destination = new WebDestination(new URL(request().operation.url), [{ address: '127.0.0.1', family: 4 }]);
    await service.request(destination, signal());
    const shown = f.presenter.presentApproval.mock.calls[0]![0].request;
    expect(shown.detail).toContain(request().operation.url);
    expect(shown.detail).toContain('127.0.0.1');
    expect(shown.detail).toContain('does not grant shell permission');
    f.presenter.presentApproval.mockImplementationOnce(async (approval, _signal, displayed) => {
      displayed();
      return { approvalId: approval.id, choiceId: 'deny' };
    });
    await expect(service.request(destination, signal())).rejects.toThrow('denied');
    f.presenter.presentApproval.mockRejectedValueOnce(new Error('offline'));
    await expect(service.request(destination, signal())).rejects.toThrow('offline');
  });
});

describe('security: shared prompt queue', () => {
  /** A queued cancellation must release its caller without advancing the active prompt/save or displaying the cancelled request later. */
  it('drains active work before later admissions, including after a queued cancellation', async () => {
    const queue = new ApprovalQueue();
    let finish!: () => void;
    const first = queue.run(
      signal(),
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const cancellation = new AbortController();
    const skipped = vi.fn(async () => {});
    const second = queue.run(cancellation.signal, skipped);
    const observed = second.catch((error: unknown) => error);
    cancellation.abort(new Error('queued cancelled'));
    await expect(observed).resolves.toMatchObject({ message: 'queued cancelled' });
    const next = vi.fn(async () => {});
    const third = queue.run(signal(), next);
    expect(next).not.toHaveBeenCalled();
    finish();
    await first;
    await third;
    expect(skipped).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    await expect(queue.run(AbortSignal.abort(new Error('precancelled')), next)).rejects.toThrow('precancelled');
    await expect(
      queue.run(signal(), () => {
        throw new Error('sync failure');
      }),
    ).rejects.toThrow('sync failure');
    await queue.run(signal(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('security: explicit host approval answers', () => {
  /** Free text, wrong IDs and missing/extra selections can never become consent. */
  it.each([
    { answers: [] },
    { answers: [{ questionId: 'approval', type: QuestionAnswerType.OTHER, text: 'allow_everything' }] },
    { answers: [{ questionId: 'other', type: QuestionAnswerType.SELECTION, optionIds: ['allow_once'] }] },
    { answers: [{ questionId: 'approval', type: QuestionAnswerType.SELECTION, optionIds: [] }] },
    {
      answers: [
        { questionId: 'approval', type: QuestionAnswerType.SELECTION, optionIds: ['allow_once', 'allow_everything'] },
      ],
    },
    { answers: [{ questionId: 'approval', type: QuestionAnswerType.SELECTION, optionIds: ['unknown'] }] },
  ] satisfies QuestionFormResult[])('rejects malformed consent %j', async result => {
    const approval = new Approval(request());
    await expect(
      new QuestionApprovalPresenter({ present: vi.fn(async () => result) }).presentApproval(approval, signal(), () => {
        approval.markDisplayed();
      }),
    ).rejects.toThrow();
  });
  /** Every policy-provided choice is shown with its meaning and mapped back to its originating request. */
  it.each(['deny', 'allow_once', 'allow_everything'])('honors %s', async choiceId => {
    const present = vi.fn(async () => ({
      answers: [{ questionId: 'approval', type: QuestionAnswerType.SELECTION as const, optionIds: [choiceId] }],
    }));
    const approval = new Approval(request());
    await expect(
      new QuestionApprovalPresenter({ present }).presentApproval(approval, signal(), () => {
        approval.markDisplayed();
      }),
    ).resolves.toEqual({ approvalId: approval.id, choiceId });
    expect(present).toHaveBeenCalledWith(
      expect.objectContaining({
        questions: [
          expect.objectContaining({
            options: expect.arrayContaining([
              expect.objectContaining({ id: 'deny', label: expect.stringContaining('Do not send') }),
            ]),
          }),
        ],
      }),
      expect.any(AbortSignal),
    );
  });
  /** Late results cannot revive cancelled consent. */
  it('rejects an answer arriving after cancellation', async () => {
    const cancellation = new AbortController();
    const approval = new Approval(request());
    const present = vi.fn(async () => {
      cancellation.abort(new Error('cancelled'));
      return { answers: [] };
    });
    await expect(
      new QuestionApprovalPresenter({ present }).presentApproval(approval, cancellation.signal, () => {
        approval.markDisplayed();
      }),
    ).rejects.toThrow('cancelled');
  });
});

describe('security: capability policies', () => {
  const operation = { command: 'echo changed', workingDirectory: '/repo', background: false, existingTerminal: false };
  /** Repeated consent updates one permission without exhausting the bounded grant repository. */
  it.each([ShellPermissionDecision.ALLOW_SAFE, ShellPermissionDecision.DENY_AND_ALLOW_SAFE])(
    'replaces duplicate safe grants on repeated %s decisions',
    async choiceId => {
      const policy = new ShellApprovalPolicy();
      const store = fixture().store;
      const permission = { capability: ApprovalCapability.SHELL, kind: 'safe_inspection' } as const;
      const original: ApprovalGrant = {
        id: 'original',
        workspace: scope,
        permission,
        originatingDecisionId: 'old',
        createdAt: 'old',
      };
      const unrelated: ApprovalGrant[] = [
        { ...original, id: 'other-workspace', workspace: { ...scope, workspaceId: 'other' } },
        { ...original, id: 'other-roots', workspace: { ...scope, mutationScope: 'other' } },
        {
          ...original,
          id: 'web',
          permission: { capability: ApprovalCapability.INTERNAL_WEB, kind: 'all_internal_web' },
        },
        {
          ...original,
          id: 'exact',
          permission: {
            capability: ApprovalCapability.SHELL,
            kind: 'exact_command',
            command: 'pwd',
            workingDirectory: '/repo',
          },
        },
      ];
      await store.save(scope, '0', [original, { ...original, id: 'duplicate' }, ...unrelated]);
      for (let index = 0; index < 3; index++) {
        const result = await new ApprovalCoordinator().resolve(
          new Approval(policy.createRequest({ workspace: scope, operation })),
          policy,
          {
            presentApproval: async (pending, _signal, displayed) => {
              displayed();
              return { approvalId: pending.id, choiceId };
            },
          },
          signal(),
          store,
        );
        expect(result.admission).toBe(choiceId === ShellPermissionDecision.ALLOW_SAFE ? 'authorized' : 'denied');
        const saved = await store.load(scope);
        expect(saved.grants).toHaveLength(unrelated.length + 1);
        expect(saved.grants).toEqual([
          ...unrelated,
          expect.objectContaining({
            workspace: scope,
            permission,
            originatingDecisionId: result.decision!.id,
          }),
        ]);
        expect(result.grantUpdate).toEqual({ kind: 'saved', grantId: saved.grants.at(-1)!.id });
      }
    },
  );
  /** Current admission and future grants are orthogonal: denying a mutation can still enable read-only inspections. */
  it.each([false, true])('keeps deny independent of preference persistence failure=%s', async fails => {
    const policy = new ShellApprovalPolicy();
    const approval = new Approval(policy.createRequest({ workspace: scope, operation }));
    const store = fixture().store;
    if (fails) store.save.mockRejectedValueOnce(new Error('quota'));
    const result = await new ApprovalCoordinator().resolve(
      approval,
      policy,
      {
        presentApproval: async (pending, _signal, displayed) => {
          displayed();
          return { approvalId: pending.id, choiceId: ShellPermissionDecision.DENY_AND_ALLOW_SAFE };
        },
      },
      signal(),
      store,
    );
    expect(result).toMatchObject({
      admission: 'denied',
      authorization: null,
      grantUpdate: { kind: fails ? 'failed' : 'saved' },
      decision: { effect: { disposition: 'deny', grant: 'safe_inspection' } },
    });
  });
  /** Policy choices preserve each sandbox profile and never turn a safe preference into authority for arbitrary commands. */
  it('maps every shell choice to its precise current and future authority', () => {
    const policy = new ShellApprovalPolicy();
    for (const choice of Object.values(ShellPermissionDecision)) {
      const approval = new Approval(policy.createRequest({ workspace: scope, operation }));
      approval.markDisplayed();
      const plan = policy.planDecision(approval, approval.select(choice, 'user'));
      expect(plan.disposition).toBe(
        [ShellPermissionDecision.DENY, ShellPermissionDecision.DENY_AND_ALLOW_SAFE].includes(choice) ? 'deny' : 'allow',
      );
      if (plan.disposition === 'allow')
        expect(plan.authorization.sandbox).toBe(
          [ShellPermissionDecision.ALLOW_EVERYTHING, ShellPermissionDecision.ALLOW_OUTSIDE_SANDBOX_ONCE].includes(
            choice,
          )
            ? ShellSandboxProfile.FULL_ACCESS
            : ShellSandboxProfile.WORKSPACE_WRITE,
        );
      expect(plan.grant?.kind ?? null).toBe(
        choice === ShellPermissionDecision.ALWAYS_ALLOW
          ? 'exact_command'
          : choice === ShellPermissionDecision.ALLOW_EVERYTHING
            ? 'all_shell_commands'
            : [ShellPermissionDecision.ALLOW_SAFE, ShellPermissionDecision.DENY_AND_ALLOW_SAFE].includes(choice)
              ? 'safe_inspection'
              : null,
      );
    }
    expect(() => policy.createRequest({ workspace: scope, operation: { ...operation, command: '  ' } })).toThrow(
      'empty',
    );
    const safe = policy.createRequest({ workspace: scope, operation: { ...operation, command: ' pwd ' } });
    expect(safe.operation.command).toBe('pwd');
    expect(safe.choices.find(choice => choice.id === 'allow_safe')?.effect).toMatchObject({
      sandbox: ShellSandboxProfile.READ_ONLY,
    });
    const permission = { capability: ApprovalCapability.SHELL, kind: 'safe_inspection' } as const;
    expect(policy.matchGrant(safe, permission)?.authorization.sandbox).toBe(ShellSandboxProfile.READ_ONLY);
    for (const changed of [{ background: true }, { existingTerminal: true }, { command: 'echo changed' }])
      expect(
        policy.matchGrant(
          policy.createRequest({ workspace: scope, operation: { ...safe.operation, ...changed } }),
          permission,
        ),
      ).toBeNull();
    expect(
      policy.matchGrant(safe, { capability: ApprovalCapability.INTERNAL_WEB, kind: 'all_internal_web' }),
    ).toBeNull();
    expect(webPolicy.matchGrant(request(), permission)).toBeNull();
    expect(
      policy.matchGrant(safe, {
        capability: ApprovalCapability.SHELL,
        kind: 'exact_command',
        command: 'pwd',
        workingDirectory: '/other',
      }),
    ).toBeNull();
    expect(
      policy.matchGrant(safe, {
        capability: ApprovalCapability.SHELL,
        kind: 'exact_command',
        command: 'ls',
        workingDirectory: '/repo',
      }),
    ).toBeNull();
  });
  /** Insertion order must not downgrade an explicitly remembered full-access policy to an older exact or safe grant. */
  it('ranks matching shell grants by policy regardless of storage order', async () => {
    const policy = new ShellApprovalPolicy();
    const grants: ApprovalGrant[] = [
      { capability: ApprovalCapability.SHELL, kind: 'safe_inspection' } as const,
      { capability: ApprovalCapability.SHELL, kind: 'all_shell_commands' } as const,
      {
        capability: ApprovalCapability.SHELL,
        kind: 'exact_command',
        command: 'pwd',
        workingDirectory: '/repo',
      } as const,
    ].map((permission, index) => ({
      id: String(index),
      workspace: scope,
      permission,
      originatingDecisionId: 'd',
      createdAt: 'now',
    }));
    const store = fixture().store;
    store.load.mockResolvedValue({ revision: '3', grants });
    const presenter = { presentApproval: vi.fn() };
    const result = await new ApprovalCoordinator().resolve(
      new Approval(policy.createRequest({ workspace: scope, operation: { ...operation, command: 'pwd' } })),
      policy,
      presenter,
      signal(),
      store,
    );
    expect(result.authorization).toMatchObject({ sandbox: ShellSandboxProfile.FULL_ACCESS });
    expect(result.decision?.origin).toMatchObject({ grantId: '1' });
    expect(presenter.presentApproval).not.toHaveBeenCalled();
  });
  /** Goals offer no blanket authority; a broad shell/web grant cannot start a goal or change mode. */
  it.each(['deny', 'allow_once'])('keeps goal %s one-shot', async choiceId => {
    const policy = new GoalApprovalPolicy();
    const approval = new Approval(policy.createRequest({ workspace: scope, operation: { objective: 'Ship' } }));
    const result = await new ApprovalCoordinator().resolve(
      approval,
      policy,
      {
        presentApproval: async (pending, _signal, displayed) => {
          displayed();
          return { approvalId: pending.id, choiceId };
        },
      },
      signal(),
    );
    expect(result.admission).toBe(choiceId === 'deny' ? 'denied' : 'authorized');
    expect(result.grantUpdate.kind).toBe('not_requested');
    expect(approval.request.timeout).toBeNull();
    expect(policy.matchGrant()).toBeNull();
    expect(new ModeSwitchApprovalPolicy({ autoApprove: false, timeoutSeconds: 15 }).matchGrant()).toBeNull();
  });
  /** A mode countdown begins on display, not while queued. Expiry records configured policy, never a user answer or remembered grant. */
  it.each([false, true])('uses displayed timeout policy autoApprove=%s', async autoApprove => {
    vi.useFakeTimers();
    const policy = new ModeSwitchApprovalPolicy({ autoApprove, timeoutSeconds: 15 });
    const approval = new Approval(
      policy.createRequest({
        workspace: scope,
        operation: { source: AgentModeID.PLAN, target: AgentModeID.AGENT, explanation: 'Implement' },
      }),
    );
    let display!: () => void;
    let promptSignal!: AbortSignal;
    const result = new ApprovalCoordinator().resolve(
      approval,
      policy,
      {
        presentApproval: (_pending, cancellation, displayed) => {
          display = displayed;
          promptSignal = cancellation;
          return new Promise(() => {});
        },
      },
      signal(),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(approval.state.kind).toBe('queued');
    display();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(approval.state.kind).toBe('awaiting_decision');
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({
      admission: autoApprove ? 'authorized' : 'denied',
      decision: { origin: { kind: 'timeout_policy' } },
      grantUpdate: { kind: 'not_requested' },
    });
    expect(promptSignal.aborted).toBe(true);
    for (const afterMilliseconds of [0, -1, NaN])
      expect(() => new Approval({ ...approval.request, timeout: { afterMilliseconds, choiceId: 'deny' } })).toThrow(
        'positive delay',
      );
    expect(
      () => new Approval({ ...approval.request, timeout: { afterMilliseconds: 1000, choiceId: 'invented' } }),
    ).toThrow('advertised');
  });
});

/** A presenter may synchronously trigger another request while publishing. The first admission must reserve its slot before invoking that callback. */
it('serializes a request enqueued reentrantly while the first prompt is being published', async () => {
  const queue = new ApprovalQueue();
  const order: string[] = [];
  let finish!: () => void;
  let nested!: Promise<void>;
  const first = queue.run(signal(), () => {
    order.push('first');
    nested = queue.run(signal(), async () => {
      order.push('nested');
    });
    return new Promise<void>(resolve => {
      finish = resolve;
    });
  });
  const beforeSettlement = [...order];
  finish();
  await first;
  await nested;
  expect(beforeSettlement).toEqual(['first']);
  expect(order).toEqual(['first', 'nested']);
});
