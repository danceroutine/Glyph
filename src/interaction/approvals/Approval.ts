import { randomUUID } from 'node:crypto';
import type { ApprovalCapability } from './ApprovalCapability.ts';
import type { ApprovalDefinitions, ApprovalRequest, AuthorizedEffect } from './ApprovalRequest.ts';

export type ApprovalDecisionOrigin =
  | { readonly kind: 'user' | 'timeout_policy' }
  | { readonly kind: 'existing_grant'; readonly grantId: string; readonly grantRevision: string };
export interface ApprovalDecision<C extends ApprovalCapability> {
  readonly id: string;
  readonly approvalId: string;
  readonly effect: ApprovalDefinitions[C]['effect'];
  readonly origin: ApprovalDecisionOrigin;
  readonly decidedAt: string;
}
export type ApprovalState<C extends ApprovalCapability> =
  | { readonly kind: 'queued' }
  | { readonly kind: 'awaiting_decision'; readonly displayedAt: string }
  | { readonly kind: 'decided'; readonly decision: ApprovalDecision<C> }
  | { readonly kind: 'cancelled' | 'failed'; readonly reason: string };

/** One immutable request and its irreversible decision; execution is a separate outcome. */
export class Approval<C extends ApprovalCapability> {
  readonly id = randomUUID();
  readonly request: ApprovalRequest<C>;
  private current: ApprovalState<C> = Object.freeze({ kind: 'queued' });

  constructor(request: ApprovalRequest<C>) {
    if (
      request.choices.length === 0 ||
      new Set(request.choices.map(choice => choice.id)).size !== request.choices.length
    )
      throw new Error('Approval choices must be nonempty and unique.');
    const timeout = request.timeout;
    if (
      timeout &&
      (!Number.isFinite(timeout.afterMilliseconds) ||
        timeout.afterMilliseconds <= 0 ||
        !request.choices.some(choice => choice.id === timeout.choiceId && choice.effect.grant === null))
    )
      throw new Error('Approval timeout must select an advertised one-shot choice after a positive delay.');
    this.request = freeze(structuredClone(request));
  }
  get state(): ApprovalState<C> {
    return this.current;
  }
  effectOf(decision: ApprovalDecision<C>): ApprovalDefinitions[C]['effect'] {
    if (this.current.kind !== 'decided' || this.current.decision !== decision)
      throw new Error('Decision does not belong to this approval.');
    return decision.effect;
  }
  markDisplayed(): void {
    this.assertPending();
    if (this.current.kind !== 'queued') throw new Error('Approval is already displayed.');
    this.current = Object.freeze({ kind: 'awaiting_decision', displayedAt: new Date().toISOString() });
  }
  validateChoice(choiceId: string): void {
    this.assertPending();
    if (!this.request.choices.some(choice => choice.id === choiceId))
      throw new Error('This choice is not available for this approval.');
  }
  select(choiceId: string, origin: 'user' | 'timeout_policy'): ApprovalDecision<C> {
    this.validateChoice(choiceId);
    if (this.current.kind !== 'awaiting_decision') throw new Error('Approval has not been displayed.');
    if (origin === 'timeout_policy' && this.request.timeout?.choiceId !== choiceId)
      throw new Error('The timeout cannot select this choice.');
    return this.decide(this.request.choices.find(choice => choice.id === choiceId)!.effect, { kind: origin });
  }
  authorizeFromGrant(effect: AuthorizedEffect<C>, grantId: string, grantRevision: string): ApprovalDecision<C> {
    this.assertPending();
    return this.decide(effect, { kind: 'existing_grant', grantId, grantRevision });
  }
  cancel(reason: string): void {
    this.assertPending();
    this.current = Object.freeze({ kind: 'cancelled', reason });
  }
  fail(reason: string): void {
    this.assertPending();
    this.current = Object.freeze({ kind: 'failed', reason });
  }
  private assertPending(): void {
    if (this.current.kind !== 'queued' && this.current.kind !== 'awaiting_decision')
      throw new Error('Approval is already settled.');
  }
  private decide(effect: ApprovalDefinitions[C]['effect'], origin: ApprovalDecisionOrigin): ApprovalDecision<C> {
    const decision = freeze({
      id: randomUUID(),
      approvalId: this.id,
      effect,
      origin,
      decidedAt: new Date().toISOString(),
    });
    this.current = Object.freeze({ kind: 'decided', decision });
    return decision;
  }
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
