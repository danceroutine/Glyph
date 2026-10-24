import { randomUUID } from 'node:crypto';
import type { Approval, ApprovalDecision } from './Approval.ts';
import type { ApprovalCapability } from './ApprovalCapability.ts';
import type { ApprovalCapabilityPolicy } from './ApprovalCapabilityPolicy.ts';
import type { ApprovalGrantStore, GrantSnapshot } from './ApprovalGrant.ts';
import { ApprovalGrantSet } from './ApprovalGrantSet.ts';
import type { ApprovalPresenter } from './ApprovalPresenter.ts';
import type { AuthorizedEffect } from './ApprovalRequest.ts';

export type GrantUpdateOutcome =
  | { readonly kind: 'not_requested' }
  | { readonly kind: 'saved'; readonly grantId: string }
  | { readonly kind: 'failed'; readonly error: unknown };
interface ApprovalResolutionBase<C extends ApprovalCapability> {
  readonly approvalId: string;
  readonly decision: ApprovalDecision<C> | null;
  readonly grantUpdate: GrantUpdateOutcome;
}
export type ApprovalResolution<C extends ApprovalCapability> = ApprovalResolutionBase<C> &
  (
    | { readonly admission: 'authorized'; readonly authorization: AuthorizedEffect<C> }
    | { readonly admission: 'denied'; readonly authorization: null }
    | { readonly admission: 'cancelled' | 'failed'; readonly authorization: null; readonly error: unknown }
  );

/** Resolves authority only. The caller owns execution and its separate outcome. */
export class ApprovalCoordinator {
  async resolve<C extends ApprovalCapability>(
    approval: Approval<C>,
    policy: ApprovalCapabilityPolicy<C>,
    presenter: ApprovalPresenter<C>,
    signal: AbortSignal,
    store?: ApprovalGrantStore,
  ): Promise<ApprovalResolution<C>> {
    let decision: ApprovalDecision<C> | null = null;
    let grantUpdate: GrantUpdateOutcome = { kind: 'not_requested' };
    try {
      signal.throwIfAborted();
      if (policy.capability !== approval.request.capability)
        throw new Error('Approval capability does not match its policy.');
      let snapshot: GrantSnapshot = { revision: '0', grants: [] };
      let grants = ApprovalGrantSet.from(snapshot.grants);
      if (store) {
        snapshot = await store.load(approval.request.workspace);
        signal.throwIfAborted();
        grants = ApprovalGrantSet.from(snapshot.grants);
        const selected = grants.match(approval.request, policy);
        if (selected)
          decision = approval.authorizeFromGrant(selected.match.authorization, selected.grant.id, snapshot.revision);
      }
      decision ??= await this.ask(approval, presenter, signal);
      signal.throwIfAborted();
      const plan = policy.planDecision(approval, decision);
      if (plan.grant) {
        try {
          if (!store) throw new Error('This approval has no grant repository.');
          const grant = {
            id: randomUUID(),
            workspace: approval.request.workspace,
            permission: plan.grant,
            originatingDecisionId: decision.id,
            createdAt: new Date().toISOString(),
          };
          // Always save against the loaded revision, including replacements:
          // permission changes while the prompt was open must still fail closed.
          await store.save(approval.request.workspace, snapshot.revision, grants.withGrant(grant).toRecords());
          grantUpdate = { kind: 'saved', grantId: grant.id };
        } catch (error) {
          grantUpdate = { kind: 'failed', error };
          if (plan.disposition === 'allow') throw error;
        }
      }
      signal.throwIfAborted();
      const outcome = { approvalId: approval.id, decision, grantUpdate };
      return plan.disposition === 'allow'
        ? { ...outcome, admission: 'authorized', authorization: plan.authorization }
        : { ...outcome, admission: 'denied', authorization: null };
    } catch (error) {
      if (approval.state.kind === 'queued' || approval.state.kind === 'awaiting_decision') {
        const message = error instanceof Error ? error.message : String(error);
        if (signal.aborted) approval.cancel(message);
        else approval.fail(message);
      }
      return {
        approvalId: approval.id,
        decision,
        admission: signal.aborted ? 'cancelled' : 'failed',
        authorization: null,
        grantUpdate,
        error,
      };
    }
  }

  private async ask<C extends ApprovalCapability>(
    approval: Approval<C>,
    presenter: ApprovalPresenter<C>,
    signal: AbortSignal,
  ): Promise<ApprovalDecision<C>> {
    const lifetime = new AbortController();
    const promptSignal = AbortSignal.any([signal, lifetime.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    let expire!: (choice: { choiceId: string; origin: 'timeout_policy' }) => void;
    const timeout = new Promise<{ choiceId: string; origin: 'timeout_policy' }>(resolve => {
      expire = resolve;
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => {
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const presented = presenter
        .presentApproval(approval, promptSignal, () => {
          approval.markDisplayed();
          const policy = approval.request.timeout;
          if (policy)
            timer = setTimeout(() => {
              expire({ choiceId: policy.choiceId, origin: 'timeout_policy' });
            }, policy.afterMilliseconds);
        })
        .then(selection => {
          if (selection.approvalId !== approval.id) throw new Error('The answer belongs to a different approval.');
          return { choiceId: selection.choiceId, origin: 'user' as const };
        });
      const selected = await Promise.race([presented, timeout, cancelled]);
      signal.throwIfAborted();
      return approval.select(selected.choiceId, selected.origin);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      lifetime.abort(new Error('Approval presentation ended.'));
    }
  }
}
