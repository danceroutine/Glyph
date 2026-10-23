import type { Logger } from '#src/observability/Logger.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditProposal } from '#src/editing/proposals/EditProposal.js';
import type { FileEditPlan } from '#src/editing/proposals/FileEditPlan.js';
import { isReviewItemPending } from './isReviewItemPending.ts';
import { EditDecisionState } from './EditDecisionState.ts';
import { EditReviewItemKind } from './EditReviewItemKind.ts';
import type { EditReviewResult } from './EditReviewResult.ts';
import type { ProposalReviewStore } from './persistence/ProposalReviewStore.ts';
import { ProposalReviewCheckpoint } from './ProposalReviewCheckpoint.ts';
import { ProposalReviewExecutor } from './ProposalReviewExecutor.ts';

export enum ProposalReviewChangeType {
  RECOVERED = 'recovered',
  STAGED = 'staged',
  DECISION = 'decision',
  ACKNOWLEDGED = 'acknowledged',
}

/** Coarse invalidation event; consumers re-read the manager's authoritative projection. */
export interface ProposalReviewChange {
  readonly type: ProposalReviewChangeType;
  readonly proposalIds: readonly string[];
  readonly pendingChangeCount: number;
}

/**
 * Owns review queue admission, ordering, persistence, and durable result delivery.
 * Individual workspace decisions and recovery are delegated to the executor through a shared checkpoint barrier.
 * Reviews remain independently addressable but retain arrival order so hosts
 * can present every actor's work as one continuous queue.
 */
export class ProposalReviewManager {
  private reviews: EditProposal[] = [];
  private completedReviews: EditProposal[] = [];
  private durableResults: readonly EditReviewResult[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly checkpoint: ProposalReviewCheckpoint;
  private readonly executor: ProposalReviewExecutor;
  private readonly settledDecisions = new Map<
    string,
    { readonly reviewId: string; readonly decision: EditDecisionState }
  >();
  private readonly logger: Logger;
  private readonly autoApplyStructural: boolean;
  private readonly autoApply: boolean;
  private readonly listeners = new Set<(change: ProposalReviewChange) => void>();

  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly store: ProposalReviewStore,
    logger: Logger = new NullLogger(),
    private readonly maxActiveReviews = 8,
    private readonly workspaceIdentity = workspace.root,
    options: {
      readonly maxReadBytes?: number;
      readonly autoApplyStructural?: boolean;
      readonly autoApply?: boolean;
    } = {},
  ) {
    this.autoApply = options.autoApply ?? false;
    this.autoApplyStructural = this.autoApply || (options.autoApplyStructural ?? false);
    const maxAllowableReadBytes = options.maxReadBytes ?? 2 * 1024 * 1024 + 3;
    if (!Number.isSafeInteger(maxAllowableReadBytes) || maxAllowableReadBytes < 0) {
      throw new Error('Review read budget must be a non-negative safe integer.');
    }
    this.logger = logger.forNamespace('editing.review');
    this.checkpoint = new ProposalReviewCheckpoint(
      () => this.saveCheckpoint(),
      () => this.persistOutcome(),
    );
    this.executor = new ProposalReviewExecutor(
      workspace,
      this.checkpoint,
      reviewId => {
        this.emitChange(ProposalReviewChangeType.DECISION, [reviewId]);
      },
      this.logger,
      maxAllowableReadBytes,
    );
  }

  get active(): EditProposal | undefined {
    return this.reviews[0];
  }
  get activeReviews(): readonly EditProposal[] {
    return [...this.reviews];
  }
  get retainedReviews(): readonly EditProposal[] {
    return [...this.reviews, ...this.completedReviews.filter(review => review.files.some(file => file.automatic))];
  }
  get pendingResults(): readonly EditReviewResult[] {
    // UI decisions may be optimistic while a save is pending. Model-facing
    // receipts must reflect only the last successful checkpoint, never that UI state.
    return structuredClone(this.durableResults);
  }
  /** Applied mutations must not be mistaken for completed, durable reviews. */
  get hasPendingCheckpoint(): boolean {
    return this.checkpoint.hasPendingCheckpoint;
  }

  /** Joins the decision queue and retries its outstanding checkpoint before continuation. */
  async flushPendingCheckpoint(): Promise<void> {
    await this.enqueue(async () => {});
  }
  get pendingChangeCount(): number {
    return this.reviews.reduce(
      (count, review) =>
        count +
        review.files.reduce(
          (fileCount, file) => fileCount + file.items.filter(item => isReviewItemPending(file, item)).length,
          0,
        ),
      0,
    );
  }
  get(reviewId: string): EditProposal | undefined {
    return this.reviews.find(review => review.id === reviewId);
  }

  onDidChange(listener: (change: ProposalReviewChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize({ reconcileWorkspace = true }: { reconcileWorkspace?: boolean } = {}): Promise<void> {
    const stored = (await this.store.load(this.workspaceIdentity)).map(value => EditProposal.from(value));
    this.durableResults = structuredClone(stored.flatMap(value => pendingReviewResults(value)));
    this.reviews = stored.filter(review => !isSettled(review));
    this.completedReviews = stored.filter(value => isSettled(value));
    for (const review of this.completedReviews) this.rememberSettledDecisions(review);
    // Persisted history is safe to display without workspace authority. Do not
    // read files or finish interrupted mutations until the host grants trust.
    if (!reconcileWorkspace) return;
    if (this.reviews.length === 0) return;
    for (const review of this.reviews) await this.executor.recover(review);
    const recoveredIds = this.reviews.map(review => review.id);
    await this.checkpoint.saveOutcome();
    await this.log('info', 'recovered', { proposalIds: recoveredIds, activeReviews: this.reviews.length });
    this.emitChange(ProposalReviewChangeType.RECOVERED, recoveredIds);
  }

  stage(proposal: EditProposal): Promise<void> {
    return this.enqueue(async () => {
      proposal = EditProposal.from(proposal);
      if (
        this.reviews.filter(review =>
          review.files.some(file => file.items.some(item => item.decision === EditDecisionState.PENDING)),
        ).length >= this.maxActiveReviews
      ) {
        throw new EditError(
          EditFailureReason.ACTIVE_REVIEW_LIMIT,
          `The ${this.maxActiveReviews}-review queue is full.`,
          { retry: 'Open /review and settle queued items before staging another proposal.' },
        );
      }
      if (this.get(proposal.id)) {
        throw new EditError(EditFailureReason.INCONSISTENT, 'A proposal with this review ID is already queued.', {
          source: proposal.id,
        });
      }
      if (this.autoApply) {
        for (const file of proposal.files) {
          for (const item of file.items) {
            if (item.kind === EditReviewItemKind.TEXT)
              item.appliedText = { state: 'applying', before: null, after: null, revertTarget: null };
          }
        }
      }
      if (this.autoApplyStructural) {
        for (const file of proposal.files) {
          const item = file.items.find(item => item.kind !== EditReviewItemKind.TEXT);
          if (item)
            file.automatic = {
              itemId: item.id,
              before: file.current ? structuredClone(file.current) : null,
              state: 'applying',
              appliedRevision: null,
            };
        }
      }
      this.reviews.push(proposal);
      try {
        await this.checkpoint.saveIntent();
      } catch (error) {
        this.reviews.pop();
        throw error;
      }
      await this.log('info', 'staged', {
        proposalId: proposal.id,
        files: proposal.files.length,
        queuePosition: this.reviews.length,
        activeReviews: this.reviews.length,
      });
      this.emitChange(ProposalReviewChangeType.STAGED, [proposal.id]);
      if (this.autoApplyStructural) {
        await this.executor.preflight(proposal);
        for (const file of proposal.files) {
          for (const item of file.items) {
            if (item.appliedText || file.automatic?.itemId === item.id)
              await this.executor.applyDecision(proposal, file, item.id, EditDecisionState.ACCEPTED);
          }
        }
      }
    });
  }

  accept(itemId: string): Promise<void> {
    return this.decide(itemId, EditDecisionState.ACCEPTED);
  }
  reject(itemId: string): Promise<void> {
    return this.decide(itemId, EditDecisionState.REJECTED);
  }
  acceptInReview(reviewId: string, itemId: string): Promise<void> {
    return this.decide(itemId, EditDecisionState.ACCEPTED, reviewId);
  }
  rejectInReview(reviewId: string, itemId: string, comment?: string): Promise<void> {
    return this.decide(itemId, EditDecisionState.REJECTED, reviewId, comment);
  }

  /** Settle an already-applied structural change, or reverse it with fresh workspace guards. */
  settleAutomatic(reviewId: string, itemId: string, keep: boolean): Promise<void> {
    return this.enqueue(() => this.executor.settleStructural(this.requireReviewId(reviewId), itemId, keep));
  }

  async acceptAll(): Promise<void> {
    return this.enqueue(async () => {
      if (this.reviews.length === 0) return;
      const reviews = this.requireReviews();
      await this.preflightAll(
        reviews.filter(
          review =>
            !review.files.some(file => file.automatic !== undefined || file.items.some(item => item.appliedText)),
        ),
      );
      for (const review of reviews) {
        for (const file of review.files) {
          for (const item of file.items) {
            if (item.appliedText && isReviewItemPending(file, item))
              await this.executor.settleText(review, file, item, EditDecisionState.ACCEPTED);
            else if (file.automatic?.itemId === item.id) await this.executor.settleStructural(review, item.id, true);
            else if (item.decision === EditDecisionState.PENDING)
              await this.executor.applyDecision(review, file, item.id, EditDecisionState.ACCEPTED);
          }
        }
      }
    });
  }

  async rejectAll(): Promise<void> {
    return this.enqueue(async () => {
      // Retrying a completed checkpoint may have settled the last review before
      // this bulk action starts. There is then nothing left to reject.
      if (this.reviews.length === 0) return;
      const reviews = this.requireReviews();
      // A failed completion checkpoint does not mean the edit failed. Recover
      // applied decisions before choosing which items remain rejectable.
      for (const review of reviews) {
        for (const file of review.files) {
          if (file.applyingItemId === null || file.applyingItemId === '') continue;
          await this.executor.reconcile(review, file);
          await this.checkpoint.saveOutcome();
        }
      }
      for (const review of reviews.toReversed()) {
        for (const file of review.files.toReversed()) {
          for (const item of file.items.toReversed()) {
            if (item.appliedText && isReviewItemPending(file, item))
              await this.executor.settleText(review, file, item, EditDecisionState.REJECTED);
            else if (file.automatic?.itemId === item.id) await this.executor.settleStructural(review, item.id, false);
          }
        }
      }
      const pendingItems = reviews.flatMap(review =>
        review.files.flatMap(file => file.items.filter(item => item.decision === EditDecisionState.PENDING)),
      );
      for (const review of reviews) {
        for (const file of review.files) {
          for (const item of file.items) {
            if (item.decision === EditDecisionState.PENDING) item.decision = EditDecisionState.REJECTED;
          }
        }
      }
      try {
        await this.checkpoint.saveOutcome();
      } catch (error) {
        for (const item of pendingItems) item.decision = EditDecisionState.PENDING;
        throw error;
      }
      await this.log('info', 'rejected_all', { proposalIds: reviews.map(review => review.id) });
      this.emitChange(
        ProposalReviewChangeType.DECISION,
        reviews.map(review => review.id),
      );
    });
  }

  acknowledgeResults(resultIds: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      const acknowledged = new Set(resultIds);
      if (acknowledged.size === 0) return;
      const proposals = [...this.reviews, ...this.completedReviews];
      const previousAcknowledgements = new Map(
        proposals.map(review => [review.id, [...(review.acknowledgedResultIds ?? [])]]),
      );
      const previousCompleted = this.completedReviews;
      let changed = false;
      for (const review of proposals) {
        const current = new Set(review.acknowledgedResultIds ?? []);
        for (const result of reviewResults(review)) {
          if (acknowledged.has(result.id) && !current.has(result.id)) {
            current.add(result.id);
            changed = true;
          }
        }
        review.acknowledgedResultIds = [...current];
      }
      if (!changed) return;
      this.completedReviews = previousCompleted.filter(
        review => pendingReviewResults(review).length > 0 || review.files.some(file => file.automatic),
      );
      try {
        await this.saveCheckpoint();
      } catch (error) {
        for (const review of proposals) {
          review.acknowledgedResultIds = previousAcknowledgements.get(review.id) ?? [];
        }
        this.completedReviews = previousCompleted;
        throw error;
      }
      this.emitChange(
        ProposalReviewChangeType.ACKNOWLEDGED,
        proposals.map(proposal => proposal.id),
      );
    });
  }

  private decide(itemId: string, decision: EditDecisionState, reviewId?: string, comment?: string): Promise<void> {
    return this.enqueue(async () => {
      const appliedReview =
        reviewId !== undefined && reviewId !== ''
          ? this.get(reviewId)
          : this.reviews.find(review => review.files.some(file => file.items.some(item => item.id === itemId)));
      const appliedFile = appliedReview?.files.find(file => file.items.some(item => item.id === itemId));
      const appliedItem = appliedFile?.items.find(item => item.id === itemId);
      if (appliedReview && appliedFile && appliedItem?.appliedText) {
        await this.executor.settleText(appliedReview, appliedFile, appliedItem, decision, comment);
        return;
      }
      if (appliedReview && appliedFile?.automatic?.itemId === itemId) {
        await this.executor.settleStructural(appliedReview, itemId, decision === EditDecisionState.ACCEPTED, comment);
        return;
      }
      const settled = this.settledDecisions.get(itemId);
      if (settled && reviewId !== undefined && reviewId !== '' && settled.reviewId !== reviewId) {
        throw new EditError(EditFailureReason.INCONSISTENT, 'Unknown review item.', {
          source: reviewId,
          hunkId: itemId,
        });
      }
      if (settled?.decision === decision) return;
      if (settled !== undefined) {
        throw new EditError(EditFailureReason.DECISION_CONFLICT, 'Review item already has the opposite decision.', {
          hunkId: itemId,
        });
      }
      const review =
        reviewId !== undefined && reviewId !== '' ? this.requireReviewId(reviewId) : this.findReviewForItem(itemId);
      const file = review.files.find(candidate => candidate.items.some(item => item.id === itemId));
      if (!file) throw new EditError(EditFailureReason.INCONSISTENT, 'Unknown review item.', { hunkId: itemId });
      await this.executor.applyDecision(review, file, itemId, decision, comment);
    });
  }

  private emitChange(type: ProposalReviewChange['type'], proposalIds: readonly string[]): void {
    const change: ProposalReviewChange = {
      type,
      proposalIds: [...proposalIds],
      pendingChangeCount: this.pendingChangeCount,
    };
    for (const listener of this.listeners) listener(change);
  }

  private async preflightAll(reviews: readonly EditProposal[]): Promise<void> {
    for (const review of reviews) await this.executor.preflight(review);
    const claimedPaths = new Map<
      string,
      {
        readonly reviewId: string;
        readonly fileId: string;
        readonly file: FileEditPlan;
        virtual: FileEditPlan['current'];
      }
    >();
    const claimedIdentities = new Map<string, string>();
    for (const review of reviews) {
      for (const file of review.files) {
        if (!file.items.some(item => item.decision === EditDecisionState.PENDING)) continue;
        if (file.current) {
          const previousPath = claimedIdentities.get(file.current.identity);
          if (previousPath !== undefined && previousPath !== file.currentPath) {
            throw queuedPathConflict(review.id, file, file.currentPath);
          }
          claimedIdentities.set(file.current.identity, file.currentPath);
        }
        const pendingRename = file.items.some(
          item => item.kind === EditReviewItemKind.RENAME && item.decision === EditDecisionState.PENDING,
        );
        const paths = pendingRename ? [file.currentPath, file.targetPath] : [file.currentPath];
        for (const path of new Set(paths)) {
          // Collision detection must agree with the workspace's path identity;
          // case folding would merge distinct resources on a case-sensitive store.
          const key = await this.workspace.canonicalPath(path);
          const existing = claimedPaths.get(key);
          if (existing && (existing.reviewId !== review.id || existing.fileId !== file.id)) {
            if (
              path === file.currentPath &&
              path === existing.file.currentPath &&
              existing.virtual &&
              existing.file.canBatchTextChanges() &&
              file.canBatchTextChanges()
            ) {
              const transformedFile = file.clone();
              if (!transformedFile.rebaseToSnapshot(existing.virtual)) {
                throw queuedPathConflict(review.id, file, path);
              }
              existing.virtual = transformedFile.simulatePendingTextChanges();
              continue;
            }
            throw queuedPathConflict(review.id, file, path);
          }
          claimedPaths.set(key, {
            reviewId: review.id,
            fileId: file.id,
            file,
            virtual: file.canBatchTextChanges() ? file.simulatePendingTextChanges() : file.current,
          });
        }
      }
    }
    // Separately valid proposals can still require the same path to be both a
    // file and a directory. Reject the whole queue before its first mutation,
    // regardless of arrival order, using the same casing policy as exact claims.
    for (const [path, claim] of claimedPaths) {
      for (let separator = path.indexOf('/'); separator !== -1; separator = path.indexOf('/', separator + 1)) {
        if (claimedPaths.has(path.slice(0, separator))) {
          throw queuedPathConflict(claim.reviewId, claim.file, path);
        }
      }
    }
    await this.logWith(this.logger.forNamespace('accept_all'), 'debug', 'queue_preflight_passed', {
      proposalIds: reviews.map(review => review.id),
    });
  }

  /** Publishes settled queue membership only after the complete outcome snapshot has been saved. */
  private async persistOutcome(): Promise<void> {
    const settled = this.reviews.filter(isSettled);
    const remaining = this.reviews.filter(review => !settled.includes(review));
    await this.saveCheckpoint([...remaining, ...this.completedReviews, ...settled]);
    this.reviews = remaining;
    this.completedReviews = [...this.completedReviews, ...settled];
    for (const review of settled) {
      this.rememberSettledDecisions(review);
      await this.log('info', 'settled', { proposalId: review.id, activeReviews: remaining.length });
    }
  }

  /** Freezes the queue before awaiting storage so receipts reflect exactly the successfully saved snapshot. */
  private async saveCheckpoint(proposals = [...this.reviews, ...this.completedReviews]): Promise<void> {
    const checkpoint = structuredClone(proposals.map(value => value.toRecord())).map(value => EditProposal.from(value));
    await this.store.save(checkpoint, this.workspaceIdentity);
    this.durableResults = checkpoint.flatMap(value => pendingReviewResults(value));
  }

  private rememberSettledDecisions(review: EditProposal): void {
    for (const file of review.files) {
      for (const item of file.items) {
        this.settledDecisions.set(item.id, { reviewId: review.id, decision: item.decision });
      }
    }
  }

  private log(level: 'debug' | 'info' | 'error', message: string, data?: unknown): Promise<void> {
    return this.logWith(this.logger, level, message, data);
  }

  private async logWith(
    logger: Logger,
    level: 'debug' | 'info' | 'error',
    message: string,
    data?: unknown,
  ): Promise<void> {
    try {
      await logger[level](message, data);
    } catch {
      // Diagnostics must never change review or workspace state.
    }
  }

  private requireReviews(): readonly EditProposal[] {
    if (this.reviews.length === 0)
      throw new EditError(EditFailureReason.INCONSISTENT, 'There are no active edit reviews.');
    return [...this.reviews];
  }

  private requireReviewId(reviewId: string): EditProposal {
    const review = this.get(reviewId);
    if (!review) throw new EditError(EditFailureReason.INCONSISTENT, 'Unknown edit review.', { source: reviewId });
    return review;
  }

  private findReviewForItem(itemId: string): EditProposal {
    const matches = this.reviews.filter(review =>
      review.files.some(file => file.items.some(item => item.id === itemId)),
    );
    if (matches.length !== 1)
      throw new EditError(
        matches.length === 0 ? EditFailureReason.INCONSISTENT : EditFailureReason.AMBIGUOUS,
        matches.length === 0 ? 'Unknown review item.' : 'Review item ID is not unique across active reviews.',
        { hunkId: itemId },
      );
    return matches[0]!;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const guarded = async (): Promise<void> => {
      await this.checkpoint.flushPendingCheckpoint();
      await operation();
    };
    const result = this.queue.then(guarded, guarded);
    this.queue = result.catch(() => {});
    return result;
  }
}

function isSettled(review: EditProposal): boolean {
  return review.files.every(
    file =>
      (!file.automatic || ['kept', 'reverted'].includes(file.automatic.state)) &&
      file.items.every(item => !isReviewItemPending(file, item)),
  );
}

function reviewResultId(reviewId: string, itemId: string): string {
  return `edit-review-result:${reviewId}:${itemId}`;
}

function reviewResults(review: EditProposal): EditReviewResult[] {
  return review.files.flatMap(file =>
    file.items
      .filter(item => !isReviewItemPending(file, item))
      .map(item => ({
        schemaVersion: 1 as const,
        id:
          reviewResultId(review.id, item.id) +
          (file.automatic?.itemId === item.id && file.automatic.state === 'reverted' ? ':reverted' : ''),
        reviewId: review.id,
        ...(review.origin ? { origin: review.origin } : {}),
        items: [
          {
            itemId: item.id,
            fileId: file.id,
            kind: item.kind,
            decision: item.decision === EditDecisionState.PENDING ? EditDecisionState.ACCEPTED : item.decision,
            affectedPaths: [...new Set([file.sourcePath, file.targetPath, file.currentPath])],
            resultingRevision: file.currentRevision,
            ...(item.rejectionComment !== undefined && item.rejectionComment !== ''
              ? { rejectionComment: item.rejectionComment }
              : {}),
          },
        ],
      })),
  );
}

export { reviewResults as reviewResults__TESTING_ONLY };

function pendingReviewResults(review: EditProposal): EditReviewResult[] {
  const acknowledged = new Set(review.acknowledgedResultIds ?? []);
  return reviewResults(review).filter(result => !acknowledged.has(result.id));
}

function queuedPathConflict(reviewId: string, file: FileEditPlan, path: string): EditError {
  return new EditError(
    EditFailureReason.DECISION_CONFLICT,
    'Accept all cannot safely merge multiple queued proposals that touch the same path.',
    {
      source: reviewId,
      fileId: file.id,
      path,
      retry: 'Review the conflicting proposals individually.',
    },
  );
}
