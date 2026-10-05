import { createHash } from 'node:crypto';
import type { Logger } from '../../observability/Logger.ts';
import { NullLogger } from '../../observability/NullLogger.ts';
import type { WorkspaceTextStore } from '../../workspace/WorkspaceTextStore.ts';
import { EditError } from '../errors/EditError.ts';
import { EditFailureReason } from '../errors/EditFailureReason.ts';
import { EditOperation } from '../proposals/EditOperation.ts';
import type { EditProposal } from '../proposals/EditProposal.ts';
import type { FileEditPlan } from '../proposals/FileEditPlan.ts';
import { EditApplicabilityState } from './EditApplicabilityState.ts';
import { EditDecisionState } from './EditDecisionState.ts';
import { EditReviewItemKind } from './EditReviewItemKind.ts';
import type { ProposalReviewStore } from './persistence/ProposalReviewStore.ts';

/**
 * Owns the lifecycle of active proposal reviews: staging, durable decisions,
 * revision preconditions, accepted workspace mutations, and crash recovery.
 * It is addressed by review ID so storage can grow beyond one active review.
 */
export class ProposalReviewManager {
  private review: EditProposal | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly settledDecisions = new Map<string, EditDecisionState>();
  private readonly logger: Logger;

  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly store: ProposalReviewStore,
    logger: Logger = new NullLogger(),
    private readonly maxActiveReviews = 1,
  ) {
    this.logger = logger.forNamespace('editing.review');
  }

  get active(): EditProposal | undefined { return this.review; }
  get(reviewId: string): EditProposal | undefined { return this.review?.id === reviewId ? this.review : undefined; }

  async initialize(): Promise<void> {
    this.review = await this.store.load();
    if (!this.review) return;
    for (const file of this.review.files) await this.reconcile(file);
    await this.persist();
    await this.logger.info('recovered', { proposalId: this.review?.id });
  }

  async stage(proposal: EditProposal): Promise<void> {
    if (this.maxActiveReviews < 1 || this.review) {
      throw new EditError(EditFailureReason.ACTIVE_REVIEW_LIMIT, 'Finish or reject the active edit review before staging another proposal.', {
        retry: 'Open /review and settle the pending items.',
      });
    }
    this.review = proposal;
    try { await this.store.save(proposal); }
    catch (error) { this.review = undefined; throw error; }
    await this.logger.info('staged', { proposalId: proposal.id, files: proposal.files.length });
  }

  accept(itemId: string): Promise<void> { return this.decide(itemId, EditDecisionState.ACCEPTED); }
  reject(itemId: string): Promise<void> { return this.decide(itemId, EditDecisionState.REJECTED); }
  acceptInReview(reviewId: string, itemId: string): Promise<void> {
    this.requireReviewId(reviewId);
    return this.accept(itemId);
  }
  rejectInReview(reviewId: string, itemId: string): Promise<void> {
    this.requireReviewId(reviewId);
    return this.reject(itemId);
  }

  async acceptAll(): Promise<void> {
    return this.enqueue(async () => {
      const proposal = this.requireReview();
      await this.preflight(proposal);
      for (const file of proposal.files) {
        for (const item of file.items) {
          if (item.decision === EditDecisionState.PENDING) await this.applyDecision(file, item.id, EditDecisionState.ACCEPTED);
        }
      }
    });
  }

  async rejectAll(): Promise<void> {
    return this.enqueue(async () => {
      const proposal = this.requireReview();
      for (const file of proposal.files) {
        for (const item of file.items) {
          if (item.decision === EditDecisionState.PENDING) item.decision = EditDecisionState.REJECTED;
        }
      }
      await this.persist();
      await this.logger.info('rejected_all', { proposalId: proposal.id });
    });
  }

  private decide(itemId: string, decision: EditDecisionState): Promise<void> {
    return this.enqueue(async () => {
      const settled = this.settledDecisions.get(itemId);
      if (settled === decision) return;
      if (settled !== undefined) {
        throw new EditError(EditFailureReason.DECISION_CONFLICT, 'Review item already has the opposite decision.', { hunkId: itemId });
      }
      const proposal = this.requireReview();
      const file = proposal.files.find(candidate => candidate.items.some(item => item.id === itemId));
      if (!file) throw new EditError(EditFailureReason.INCONSISTENT, 'Unknown review item.', { hunkId: itemId });
      await this.applyDecision(file, itemId, decision);
    });
  }

  private async applyDecision(file: FileEditPlan, itemId: string, decision: EditDecisionState): Promise<void> {
    const item = file.items.find(candidate => candidate.id === itemId)!;
    if (item.decision === decision) return;
    if (item.decision !== EditDecisionState.PENDING) {
      throw new EditError(EditFailureReason.DECISION_CONFLICT, 'Review item already has the opposite decision.', { fileId: file.id, hunkId: item.id });
    }
    if (decision === EditDecisionState.REJECTED) {
      item.decision = decision;
      await this.persist();
      await this.logger.info('item.rejected', { proposalId: this.review?.id, fileId: file.id, itemId });
      return;
    }
    file.applicability = EditApplicabilityState.APPLYING;
    file.applyingItemId = item.id;
    try { await this.persist(); }
    catch (error) {
      file.applicability = EditApplicabilityState.FAILED_RETRYABLE;
      file.applyingItemId = null;
      throw error;
    }
    const mutation = this.review ? { undoGroupId: this.review.id } : {};
    try {
      await this.logger.debug('revision.check', {
        proposalId: this.review?.id,
        fileId: file.id,
        path: file.currentPath,
        expectedRevision: file.currentRevision,
        itemId,
      });
      switch (item.kind) {
        case EditReviewItemKind.CREATE: {
          const result = await this.workspace.create(file.targetPath, file.proposed.text, file.proposed.byteOrderMark, file.proposed.mode, mutation);
          file.currentPath = result.path;
          file.currentRevision = result.revision;
          file.current = result;
          break;
        }
        case EditReviewItemKind.DELETE:
          if (!file.currentRevision) throw this.stale(file);
          await this.workspace.delete(file.currentPath, file.currentRevision, mutation);
          file.currentRevision = null;
          file.current = null;
          break;
        case EditReviewItemKind.RENAME: {
          if (!file.currentRevision) throw this.stale(file);
          const result = await this.workspace.rename(file.currentPath, file.targetPath, file.currentRevision, mutation);
          file.currentPath = result.path;
          file.currentRevision = result.revision;
          file.current = result;
          break;
        }
        case EditReviewItemKind.TEXT: {
          if (!file.base || !file.currentRevision) throw this.stale(file);
          item.decision = EditDecisionState.ACCEPTED;
          const text = compose(file);
          const result = await this.workspace.replace(file.currentPath, file.currentRevision, text, file.proposed.byteOrderMark, mutation);
          file.currentRevision = result.revision;
          file.current = result;
          break;
        }
      }
      item.decision = EditDecisionState.ACCEPTED;
      file.applicability = EditApplicabilityState.READY;
      file.applyingItemId = null;
      await this.persist();
      await this.logger.info('item.accepted', { proposalId: this.review?.id, fileId: file.id, itemId, revision: file.currentRevision });
    } catch (error) {
      if (error instanceof EditError && error.reason === EditFailureReason.STALE) file.applicability = EditApplicabilityState.STALE;
      else file.applicability = EditApplicabilityState.FAILED_RETRYABLE;
      if (item.kind === EditReviewItemKind.TEXT) item.decision = EditDecisionState.PENDING;
      file.applyingItemId = null;
      await this.persist();
      await this.logger.error('item.failed', {
        proposalId: this.review?.id,
        fileId: file.id,
        itemId,
        error: error instanceof EditError ? error.toJSON() : { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  private async preflight(proposal: EditProposal): Promise<void> {
    for (const file of proposal.files) {
      if (!file.items.some(item => item.decision === EditDecisionState.PENDING)) continue;
      if (file.applicability === EditApplicabilityState.STALE) throw this.stale(file);
      const current = await this.workspace.readOptional(file.currentPath);
      if (file.currentRevision === null ? current !== undefined : current?.revision !== file.currentRevision) {
        file.applicability = EditApplicabilityState.STALE;
        await this.persist();
        throw this.stale(file, current?.revision);
      }
      const rename = file.items.find(item => item.kind === EditReviewItemKind.RENAME && item.decision === EditDecisionState.PENDING);
      if (rename && await this.workspace.readOptional(file.targetPath)) throw this.stale(file);
    }
    await this.logger.forNamespace('accept_all').debug('preflight_passed', { proposalId: proposal.id });
  }

  private async reconcile(file: FileEditPlan): Promise<void> {
    const current = await this.workspace.readOptional(file.currentPath);
    const applying = file.applyingItemId ? file.items.find(item => item.id === file.applyingItemId) : undefined;
    if (applying) {
      const recovered = await this.reconcileApplying(file, applying, current);
      if (recovered) return;
    }
    if (file.currentRevision === null ? current !== undefined : current?.revision !== file.currentRevision) file.applicability = EditApplicabilityState.STALE;
    else {
      file.current = current ?? null;
      file.applicability = EditApplicabilityState.READY;
      file.applyingItemId = null;
    }
  }

  private async reconcileApplying(
    file: FileEditPlan,
    item: FileEditPlan['items'][number],
    current: FileEditPlan['current'] | undefined,
  ): Promise<boolean> {
    let after = current ?? null;
    if (item.kind === EditReviewItemKind.RENAME) {
      const target = await this.workspace.readOptional(file.targetPath) ?? null;
      if (current && target && current.identity === target.identity && current.revision === file.currentRevision) {
        await this.workspace.delete(file.currentPath, current.revision, this.review ? { undoGroupId: this.review.id } : {});
        after = target;
      } else if (!current) after = target;
    }
    const applied = item.kind === EditReviewItemKind.DELETE
      ? !current
      : item.kind === EditReviewItemKind.CREATE
        ? after?.revision === file.proposed.revision
        : item.kind === EditReviewItemKind.RENAME
          ? after?.revision === file.currentRevision && after.path === file.targetPath
          : after?.revision === revisionOf(composeWith(file, item.id), file.proposed.byteOrderMark);
    if (!applied) return false;
    item.decision = EditDecisionState.ACCEPTED;
    file.current = after;
    file.currentPath = after?.path ?? file.currentPath;
    file.currentRevision = after?.revision ?? null;
    file.applicability = EditApplicabilityState.READY;
    file.applyingItemId = null;
    return true;
  }

  private async persist(): Promise<void> {
    const review = this.review;
    if (!review) return;
    const settled = review.files.every(file => file.items.every(item => item.decision !== EditDecisionState.PENDING));
    if (settled) {
      for (const file of review.files) for (const item of file.items) this.settledDecisions.set(item.id, item.decision);
      await this.store.clear();
      this.review = undefined;
      await this.logger.info('settled', { proposalId: review.id });
    } else await this.store.save(review);
  }

  private stale(file: FileEditPlan, currentRevision?: string): EditError {
    return new EditError(EditFailureReason.STALE, 'The file changed outside this proposal review.', {
      fileId: file.id,
      path: file.currentPath,
      ...(currentRevision ? { currentRevision } : {}),
      retry: 'Leave this item pending and submit a fresh proposal from the current file.',
    });
  }

  private requireReview(): EditProposal {
    if (!this.review) throw new EditError(EditFailureReason.INCONSISTENT, 'There is no active edit review.');
    return this.review;
  }

  private requireReviewId(reviewId: string): EditProposal {
    const review = this.requireReview();
    if (review.id !== reviewId) throw new EditError(EditFailureReason.INCONSISTENT, 'Unknown edit review.', { source: reviewId });
    return review;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}

function compose(file: FileEditPlan): string {
  if (!file.base) return file.proposed.text;
  let text = file.base.text;
  const accepted = file.items
    .filter(item => item.kind === EditReviewItemKind.TEXT && item.decision === EditDecisionState.ACCEPTED)
    .sort((left, right) => right.sourceStart - left.sourceStart);
  for (const item of accepted) text = text.slice(0, item.sourceStart) + item.insertedText + text.slice(item.sourceEnd);
  return text;
}

function composeWith(file: FileEditPlan, itemId: string): string {
  const item = file.items.find(candidate => candidate.id === itemId);
  if (!item) return compose(file);
  const previous = item.decision;
  item.decision = EditDecisionState.ACCEPTED;
  try { return compose(file); } finally { item.decision = previous; }
}

function revisionOf(text: string, byteOrderMark: boolean): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha256').update(byteOrderMark
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
    : bytes).digest('hex');
}
