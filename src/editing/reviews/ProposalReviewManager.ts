import { createHash } from 'node:crypto';
import type { Logger } from '#src/observability/Logger.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import { WorkspaceReadLimitError } from '#src/workspace/WorkspaceReadLimitError.js';
import { transformTextEditRanges } from '#src/editing/documents/transformTextEditRanges.js';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import type { EditProposal } from '#src/editing/proposals/EditProposal.js';
import type { FileEditPlan } from '#src/editing/proposals/FileEditPlan.js';
import { EditApplicabilityState } from './EditApplicabilityState.ts';
import { EditDecisionState } from './EditDecisionState.ts';
import { EditReviewItemKind } from './EditReviewItemKind.ts';
import type { EditReviewResult } from './EditReviewResult.ts';
import type { ProposalReviewStore } from './persistence/ProposalReviewStore.ts';

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
 * Owns the lifecycle of active proposal reviews: staging, durable decisions,
 * revision preconditions, accepted workspace mutations, and crash recovery.
 * Reviews remain independently addressable but retain arrival order so hosts
 * can present every actor's work as one continuous queue.
 */
export class ProposalReviewManager {
  private reviews: EditProposal[] = [];
  private completedReviews: EditProposal[] = [];
  private durableResults: readonly EditReviewResult[] = [];
  private queue: Promise<void> = Promise.resolve();
  private mutationCheckpointPending = false;
  private readonly settledDecisions = new Map<
    string,
    { readonly reviewId: string; readonly decision: EditDecisionState }
  >();
  private readonly logger: Logger;
  private readonly maxReadBytes: number;
  private readonly listeners = new Set<(change: ProposalReviewChange) => void>();

  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly store: ProposalReviewStore,
    logger: Logger = new NullLogger(),
    private readonly maxActiveReviews = 8,
    private readonly workspaceIdentity = workspace.root,
    options: { readonly maxReadBytes?: number } = {},
  ) {
    this.maxReadBytes = options.maxReadBytes ?? 2 * 1024 * 1024 + 3;
    if (!Number.isSafeInteger(this.maxReadBytes) || this.maxReadBytes < 0) {
      throw new Error('Review read budget must be a non-negative safe integer.');
    }
    this.logger = logger.forNamespace('editing.review');
  }

  get active(): EditProposal | undefined {
    return this.reviews[0];
  }
  get activeReviews(): readonly EditProposal[] {
    return [...this.reviews];
  }
  get pendingResults(): readonly EditReviewResult[] {
    // UI decisions may be optimistic while a save is pending. Model-facing
    // receipts must reflect only the last successful checkpoint, never that UI state.
    return structuredClone(this.durableResults);
  }
  /** Applied mutations must not be mistaken for completed, durable reviews. */
  get hasPendingCheckpoint(): boolean {
    return this.mutationCheckpointPending;
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
          (fileCount, file) =>
            fileCount + file.items.filter(item => item.decision === EditDecisionState.PENDING).length,
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
    return () => this.listeners.delete(listener);
  }

  async initialize({ reconcileWorkspace = true }: { reconcileWorkspace?: boolean } = {}): Promise<void> {
    const stored = await this.store.load(this.workspaceIdentity);
    this.durableResults = structuredClone(stored.flatMap(pendingReviewResults));
    this.reviews = stored.filter(review => !isSettled(review));
    this.completedReviews = stored.filter(isSettled);
    for (const review of this.completedReviews) this.rememberSettledDecisions(review);
    // Persisted history is safe to display without workspace authority. Do not
    // read files or finish interrupted mutations until the host grants trust.
    if (!reconcileWorkspace) return;
    if (this.reviews.length === 0) return;
    for (const review of this.reviews) {
      for (const file of review.files) await this.reconcile(review, file);
    }
    const recoveredIds = this.reviews.map(review => review.id);
    await this.persist();
    await this.log('info', 'recovered', { proposalIds: recoveredIds, activeReviews: this.reviews.length });
    this.emitChange(ProposalReviewChangeType.RECOVERED, recoveredIds);
  }

  stage(proposal: EditProposal): Promise<void> {
    return this.enqueue(async () => {
      if (this.reviews.length >= this.maxActiveReviews) {
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
      this.reviews.push(proposal);
      try {
        await this.saveCheckpoint();
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
  rejectInReview(reviewId: string, itemId: string): Promise<void> {
    return this.decide(itemId, EditDecisionState.REJECTED, reviewId);
  }

  async acceptAll(): Promise<void> {
    return this.enqueue(async () => {
      if (this.reviews.length === 0) return;
      const reviews = this.requireReviews();
      await this.preflightAll(reviews);
      for (const review of reviews) {
        for (const file of review.files) {
          for (const item of file.items) {
            if (item.decision === EditDecisionState.PENDING)
              await this.applyDecision(review, file, item.id, EditDecisionState.ACCEPTED);
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
          if (!file.applyingItemId) continue;
          await this.reconcile(review, file);
          await this.persist();
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
        await this.persist();
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
      this.completedReviews = previousCompleted.filter(review => pendingReviewResults(review).length > 0);
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

  private decide(itemId: string, decision: EditDecisionState, reviewId?: string): Promise<void> {
    return this.enqueue(async () => {
      const settled = this.settledDecisions.get(itemId);
      if (settled && reviewId && settled.reviewId !== reviewId) {
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
      const review = reviewId ? this.requireReviewId(reviewId) : this.findReviewForItem(itemId);
      const file = review.files.find(candidate => candidate.items.some(item => item.id === itemId));
      if (!file) throw new EditError(EditFailureReason.INCONSISTENT, 'Unknown review item.', { hunkId: itemId });
      await this.applyDecision(review, file, itemId, decision);
    });
  }

  private async applyDecision(
    review: EditProposal,
    file: FileEditPlan,
    itemId: string,
    decision: EditDecisionState,
  ): Promise<void> {
    const item = file.items.find(candidate => candidate.id === itemId)!;
    if (file.applyingItemId) {
      await this.reconcile(review, file);
      await this.persist();
    }
    if (item.decision === decision) return;
    if (item.decision !== EditDecisionState.PENDING) {
      throw new EditError(EditFailureReason.DECISION_CONFLICT, 'Review item already has the opposite decision.', {
        fileId: file.id,
        hunkId: item.id,
      });
    }
    if (decision === EditDecisionState.REJECTED) {
      item.decision = decision;
      try {
        await this.persist();
      } catch (error) {
        item.decision = EditDecisionState.PENDING;
        throw error;
      }
      await this.log('info', 'item.rejected', { proposalId: review.id, fileId: file.id, itemId });
      this.emitChange(ProposalReviewChangeType.DECISION, [review.id]);
      return;
    }
    await this.synchronize(file);
    file.applicability = EditApplicabilityState.APPLYING;
    file.applyingItemId = item.id;
    try {
      await this.persist();
    } catch (error) {
      file.applicability = EditApplicabilityState.FAILED_RETRYABLE;
      file.applyingItemId = null;
      throw error;
    }
    const applyingState = captureFileState(file);
    const operationId = `${review.id}:${file.id}:${item.id}`;
    const mutation = { operationId, undoGroupId: operationId };
    let applicability = EditApplicabilityState.READY;
    try {
      await this.log('debug', 'revision.check', {
        proposalId: review.id,
        fileId: file.id,
        path: file.currentPath,
        expectedRevision: file.currentRevision,
        itemId,
      });
      switch (item.kind) {
        case EditReviewItemKind.CREATE: {
          const result = await this.workspace.create(
            file.targetPath,
            file.proposed.text,
            file.proposed.byteOrderMark,
            file.proposed.mode,
            mutation,
          );
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
          updateBaseline(file, result);
          break;
        }
        case EditReviewItemKind.TEXT: {
          if (!file.base || !file.current || !file.currentRevision) throw this.stale(file);
          const textChange = planTextAcceptance(file, item);
          if (!textChange) throw this.stale(file, file.currentRevision);
          // Keep the public receipt pending until the workspace confirms the
          // mutation; concurrent chat flushes may inspect it while we await.
          const result = await this.workspace.replace(
            file.currentPath,
            file.currentRevision,
            textChange.text,
            file.proposed.byteOrderMark,
            mutation,
          );
          // The mutation is complete even if editor normalization invalidates
          // another pending range. Never restore its pre-edit decision state.
          this.mutationCheckpointPending = true;
          const previous = { ...file };
          item.decision = EditDecisionState.ACCEPTED;
          file.current = result;
          file.currentPath = result.path;
          file.currentRevision = result.revision;
          file.applyingItemId = null;
          file.applicability = EditApplicabilityState.STALE;
          const actual = planTextAcceptance(previous, item, result.text);
          if (actual) {
            applyTransformedRanges(actual.transformedItems);
            updateBaseline(file, result);
          } else {
            // Keep the old base/ranges as conflict evidence, but checkpoint the
            // observed current document and the completed item's acceptance.
            applicability = EditApplicabilityState.STALE;
          }
          break;
        }
      }
      item.decision = EditDecisionState.ACCEPTED;
      file.applicability = applicability;
      file.applyingItemId = null;
      this.mutationCheckpointPending = true;
      await this.persist();
    } catch (error) {
      if (this.mutationCheckpointPending) {
        // The workspace's observed result is stronger evidence than predicted
        // bytes. Keep it across save failures and block decisions until saved.
        try {
          await this.persist();
        } catch {
          /* Retried by the next queued operation. */
        }
      } else {
        restoreFileState(file, applyingState);
        try {
          await this.reconcile(review, file);
          await this.persist();
        } catch {
          restoreFileState(file, applyingState);
        }
      }
      await this.log('error', 'item.failed', {
        proposalId: review.id,
        fileId: file.id,
        itemId,
        error:
          error instanceof EditError
            ? error.toJSON()
            : { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
    await this.log('info', 'item.accepted', {
      proposalId: review.id,
      fileId: file.id,
      itemId,
      revision: file.currentRevision,
    });
    this.emitChange(ProposalReviewChangeType.DECISION, [review.id]);
  }

  private emitChange(type: ProposalReviewChange['type'], proposalIds: readonly string[]): void {
    const change: ProposalReviewChange = {
      type,
      proposalIds: [...proposalIds],
      pendingChangeCount: this.pendingChangeCount,
    };
    for (const listener of this.listeners) listener(change);
  }

  private async preflight(proposal: EditProposal): Promise<void> {
    for (const file of proposal.files) {
      if (file.applyingItemId) {
        await this.reconcile(proposal, file);
        await this.persist();
      }
      if (!file.items.some(item => item.decision === EditDecisionState.PENDING)) continue;
      await this.synchronize(file);
      const rename = file.items.find(
        item => item.kind === EditReviewItemKind.RENAME && item.decision === EditDecisionState.PENDING,
      );
      if (rename && (await this.workspace.exists(file.targetPath))) throw this.stale(file);
    }
    await this.logWith(this.logger.forNamespace('accept_all'), 'debug', 'preflight_passed', {
      proposalId: proposal.id,
    });
  }

  private async preflightAll(reviews: readonly EditProposal[]): Promise<void> {
    for (const review of reviews) await this.preflight(review);
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
              canBatchTextChanges(existing.file, file)
            ) {
              const transformedFile = cloneFileForTransform(file);
              if (!rebaseFileToSnapshot(transformedFile, existing.virtual)) {
                throw queuedPathConflict(review.id, file, path);
              }
              existing.virtual = simulatePendingTextChanges(transformedFile);
              continue;
            }
            throw queuedPathConflict(review.id, file, path);
          }
          claimedPaths.set(key, {
            reviewId: review.id,
            fileId: file.id,
            file,
            virtual: canBatchTextChanges(file) ? simulatePendingTextChanges(file) : file.current,
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

  private async reconcile(review: EditProposal, file: FileEditPlan): Promise<void> {
    if (file.currentRevision === null && !file.applyingItemId) {
      if (!(await this.synchronizeNewFile(file))) file.applicability = EditApplicabilityState.STALE;
      return;
    }
    let current: FileEditPlan['current'] | undefined;
    try {
      current = await this.workspace.readOptional(file.currentPath, { maxBytes: this.maxReadBytes });
    } catch (error) {
      if (!isUnreviewableSnapshot(error)) throw error;
      // A path replaced by a directory, binary file, or disallowed resource is
      // stale, not absent, as is content beyond the recovery read budget or a
      // file identity that changed while opening. None proves a pending DELETE ran.
      // Retain the reviewed text so the user can inspect and reject the proposal.
      file.applicability = EditApplicabilityState.STALE;
      file.applyingItemId = null;
      return;
    }
    const applying = file.applyingItemId ? file.items.find(item => item.id === file.applyingItemId) : undefined;
    if (applying) {
      const recovered = await this.reconcileApplying(review, file, applying, current);
      if (recovered) return;
    }
    if (this.synchronizeSnapshot(file, current)) return;
    file.applicability = EditApplicabilityState.STALE;
    file.applyingItemId = null;
  }

  private async reconcileApplying(
    review: EditProposal,
    file: FileEditPlan,
    item: FileEditPlan['items'][number],
    current: FileEditPlan['current'] | undefined,
  ): Promise<boolean> {
    let after = current ?? null;
    if (item.kind === EditReviewItemKind.RENAME) {
      let target: FileEditPlan['current'];
      try {
        target = (await this.workspace.readOptional(file.targetPath, { maxBytes: this.maxReadBytes })) ?? null;
      } catch (error) {
        if (!isUnreviewableSnapshot(error)) throw error;
        // An unreadable destination cannot prove the rename completed. Retain
        // both paths and allow rejection without retrying destructive cleanup.
        file.applicability = EditApplicabilityState.STALE;
        file.applyingItemId = null;
        return true;
      }
      if (current && target && current.identity === target.identity && current.revision === file.currentRevision) {
        const operationId = `${review.id}:${file.id}:${item.id}:rename_cleanup`;
        try {
          await this.workspace.delete(file.currentPath, current.revision, { operationId, undoGroupId: operationId });
        } catch (error) {
          const sourceVanished =
            typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
          if (!isUnreviewableSnapshot(error) && !sourceVanished) throw error;
          // The source may change after both snapshots were inspected. A
          // rejected cleanup is not a completed rename: retain both paths and
          // the pending decision, and stop automatically retrying its deletion.
          file.applicability = EditApplicabilityState.STALE;
          file.applyingItemId = null;
          return true;
        }
        after = target;
      } else if (!current) after = target;
    }
    const applied =
      item.kind === EditReviewItemKind.DELETE
        ? !current
        : item.kind === EditReviewItemKind.CREATE
          ? after?.revision === file.proposed.revision
          : item.kind === EditReviewItemKind.RENAME
            ? after?.revision === file.currentRevision && after.path === file.targetPath
            : after?.revision === revisionOf(composeWith(file, item.id), file.proposed.byteOrderMark);
    if (!applied) return false;
    item.decision = EditDecisionState.ACCEPTED;
    if (item.kind === EditReviewItemKind.TEXT && after) {
      const textChange = planTextAcceptance(file, item, after.text);
      if (!textChange) return false;
      applyTransformedRanges(textChange.transformedItems);
      updateBaseline(file, after);
    } else {
      file.current = after;
      file.currentPath = after?.path ?? file.currentPath;
      file.currentRevision = after?.revision ?? null;
      if (item.kind === EditReviewItemKind.RENAME && after) updateBaseline(file, after);
    }
    file.applicability = EditApplicabilityState.READY;
    file.applyingItemId = null;
    return true;
  }

  private async synchronize(file: FileEditPlan): Promise<void> {
    if (file.currentRevision === null) {
      const ready = await this.synchronizeNewFile(file);
      if (!ready) file.applicability = EditApplicabilityState.STALE;
      await this.persist();
      if (!ready) throw this.stale(file);
      return;
    }
    let current: FileEditPlan['current'] | undefined;
    try {
      current = await this.workspace.readOptional(file.currentPath, { maxBytes: this.maxReadBytes });
    } catch (error) {
      if (!isUnreviewableSnapshot(error)) throw error;
      file.applicability = EditApplicabilityState.STALE;
      await this.persist();
      throw this.stale(file);
    }
    if (this.synchronizeSnapshot(file, current)) {
      await this.persist();
      return;
    }
    file.applicability = EditApplicabilityState.STALE;
    await this.persist();
    throw this.stale(file, current?.revision);
  }

  private async synchronizeNewFile(file: FileEditPlan): Promise<boolean> {
    // Pending CREATE only needs proof that the path is absent. Content is needed
    // solely when recovering an applying CREATE to recognize its expected hash.
    try {
      if (await this.workspace.exists(file.currentPath)) return false;
    } catch (error) {
      if (!isUnreviewableSnapshot(error)) throw error;
      return false;
    }
    return this.synchronizeSnapshot(file, undefined);
  }

  private synchronizeSnapshot(file: FileEditPlan, current: FileEditPlan['current'] | undefined): boolean {
    if (file.currentRevision === null) {
      if (current !== undefined) return false;
      file.current = null;
      file.applicability = EditApplicabilityState.READY;
      file.applyingItemId = null;
      return true;
    }
    if (!current || !file.current) return false;

    if (file.base && file.base.revision !== file.current.revision) {
      if (!rebasePendingTextItems(file, file.base.text, file.current.text)) return false;
      updateBaseline(file, file.current);
    }
    if (current.revision !== file.currentRevision) {
      if (!canRebase(file) || !rebasePendingTextItems(file, file.current.text, current.text)) return false;
      updateBaseline(file, current);
    } else {
      updateBaseline(file, current);
    }
    file.applicability = EditApplicabilityState.READY;
    file.applyingItemId = null;
    return true;
  }

  private async persist(): Promise<void> {
    const settled = this.reviews.filter(isSettled);
    const remaining = this.reviews.filter(review => !settled.includes(review));
    await this.saveCheckpoint([...remaining, ...this.completedReviews, ...settled]);
    this.mutationCheckpointPending = false;
    this.reviews = remaining;
    this.completedReviews = [...this.completedReviews, ...settled];
    for (const review of settled) {
      this.rememberSettledDecisions(review);
      await this.log('info', 'settled', { proposalId: review.id, activeReviews: remaining.length });
    }
  }

  private async saveCheckpoint(proposals = [...this.reviews, ...this.completedReviews]): Promise<void> {
    const checkpoint = structuredClone(proposals);
    await this.store.save(checkpoint, this.workspaceIdentity);
    this.durableResults = checkpoint.flatMap(pendingReviewResults);
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

  private stale(file: FileEditPlan, currentRevision?: string): EditError {
    return new EditError(EditFailureReason.STALE, 'The file changed outside this proposal review.', {
      fileId: file.id,
      path: file.currentPath,
      ...(currentRevision ? { currentRevision } : {}),
      retry: 'Leave this item pending and submit a fresh proposal from the current file.',
    });
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
      if (this.mutationCheckpointPending) await this.persist();
      await operation();
    };
    const result = this.queue.then(guarded, guarded);
    this.queue = result.catch(() => {});
    return result;
  }
}

function isUnreviewableSnapshot(error: unknown): boolean {
  return (
    error instanceof WorkspaceReadLimitError ||
    (error instanceof EditError &&
      (error.reason === EditFailureReason.UNSUPPORTED || error.reason === EditFailureReason.STALE))
  );
}

function isSettled(review: EditProposal): boolean {
  return review.files.every(file => file.items.every(item => item.decision !== EditDecisionState.PENDING));
}

function reviewResultId(reviewId: string, itemId: string): string {
  return `edit-review-result:${reviewId}:${itemId}`;
}

function reviewResults(review: EditProposal): EditReviewResult[] {
  return review.files.flatMap(file =>
    file.items
      .filter(item => item.decision !== EditDecisionState.PENDING)
      .map(item => ({
        schemaVersion: 1 as const,
        id: reviewResultId(review.id, item.id),
        reviewId: review.id,
        ...(review.origin ? { origin: review.origin } : {}),
        items: [
          {
            itemId: item.id,
            fileId: file.id,
            kind: item.kind,
            decision: item.decision as Exclude<EditDecisionState, EditDecisionState.PENDING>,
            affectedPaths: [...new Set([file.sourcePath, file.targetPath, file.currentPath])],
            resultingRevision: file.currentRevision,
          },
        ],
      })),
  );
}

function pendingReviewResults(review: EditProposal): EditReviewResult[] {
  const acknowledged = new Set(review.acknowledgedResultIds ?? []);
  return reviewResults(review).filter(result => !acknowledged.has(result.id));
}

function composeWith(file: FileEditPlan, itemId: string): string {
  const item = file.items.find(candidate => candidate.id === itemId);
  if (!item || item.kind !== EditReviewItemKind.TEXT || !file.current) return file.current?.text ?? '';
  return applyTextItem(file.current.text, item);
}

function canRebase(file: FileEditPlan): boolean {
  return file.operation === EditOperation.UPDATE || file.operation === EditOperation.RENAME;
}

function canBatchTextChanges(...files: FileEditPlan[]): boolean {
  return files.every(
    file =>
      file.operation === EditOperation.UPDATE &&
      file.items.some(item => item.decision === EditDecisionState.PENDING) &&
      file.items
        .filter(item => item.decision === EditDecisionState.PENDING)
        .every(item => item.kind === EditReviewItemKind.TEXT),
  );
}

function cloneFileForTransform(file: FileEditPlan): FileEditPlan {
  return { ...file, items: file.items.map(item => ({ ...item })) };
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

function rebaseFileToSnapshot(file: FileEditPlan, current: NonNullable<FileEditPlan['current']>): boolean {
  if (!file.current || !rebasePendingTextItems(file, file.current.text, current.text)) return false;
  updateBaseline(file, current);
  return true;
}

function simulatePendingTextChanges(file: FileEditPlan): NonNullable<FileEditPlan['current']> {
  if (!file.current) throw new Error('Cannot simulate text changes without a current document.');
  const text = composePendingText(file, file.current.text);
  return snapshotForProposal(file, file.current, text, file.proposed.byteOrderMark);
}

function rebasePendingTextItems(file: FileEditPlan, previousText: string, currentText: string): boolean {
  const items = file.items.filter(
    item => item.kind === EditReviewItemKind.TEXT && item.decision === EditDecisionState.PENDING,
  );
  const ranges = transformTextEditRanges(previousText, currentText, items);
  if (!ranges) return false;
  applyTransformedRanges(items.map((item, index) => ({ item, range: ranges[index]! })));
  return true;
}

function planTextAcceptance(
  file: FileEditPlan,
  item: FileEditPlan['items'][number],
  actualText?: string,
):
  | {
      readonly text: string;
      readonly transformedItems: readonly TransformedItem[];
    }
  | undefined {
  if (!file.current || item.kind !== EditReviewItemKind.TEXT) return undefined;
  let text: string;
  try {
    text = applyTextItem(file.current.text, item);
  } catch {
    return undefined;
  }
  const remaining = file.items.filter(
    candidate =>
      candidate.id !== item.id &&
      candidate.kind === EditReviewItemKind.TEXT &&
      candidate.decision === EditDecisionState.PENDING,
  );
  // Editor-backed stores may normalize EOLs or automatic whitespace. Pending
  // ranges must follow the observed result, never predicted replacement bytes.
  const ranges = transformTextEditRanges(file.current.text, actualText ?? text, remaining);
  if (!ranges) return undefined;
  return {
    text,
    transformedItems: remaining.map((candidate, index) => ({ item: candidate, range: ranges[index]! })),
  };
}

interface TransformedItem {
  readonly item: FileEditPlan['items'][number];
  readonly range: { readonly sourceStart: number; readonly sourceEnd: number };
}

interface FileEditPlanState {
  readonly base: FileEditPlan['base'];
  readonly proposed: FileEditPlan['proposed'];
  readonly current: FileEditPlan['current'];
  readonly applyingItemId: string | null;
  readonly createdDirectories: readonly string[];
  readonly applicability: EditApplicabilityState;
  readonly currentPath: string;
  readonly currentRevision: string | null;
  readonly items: readonly {
    readonly id: string;
    readonly sourceStart: number;
    readonly sourceEnd: number;
    readonly decision: EditDecisionState;
  }[];
}

function captureFileState(file: FileEditPlan): FileEditPlanState {
  return {
    base: file.base,
    proposed: file.proposed,
    current: file.current,
    applyingItemId: file.applyingItemId,
    createdDirectories: [...file.createdDirectories],
    applicability: file.applicability,
    currentPath: file.currentPath,
    currentRevision: file.currentRevision,
    items: file.items.map(item => ({
      id: item.id,
      sourceStart: item.sourceStart,
      sourceEnd: item.sourceEnd,
      decision: item.decision,
    })),
  };
}

function restoreFileState(file: FileEditPlan, state: FileEditPlanState): void {
  file.base = state.base;
  file.proposed = state.proposed;
  file.current = state.current;
  file.applyingItemId = state.applyingItemId;
  file.createdDirectories = [...state.createdDirectories];
  file.applicability = state.applicability;
  file.currentPath = state.currentPath;
  file.currentRevision = state.currentRevision;
  for (const itemState of state.items) {
    const item = file.items.find(candidate => candidate.id === itemState.id);
    if (!item) continue;
    item.sourceStart = itemState.sourceStart;
    item.sourceEnd = itemState.sourceEnd;
    item.decision = itemState.decision;
  }
}

function applyTransformedRanges(items: readonly TransformedItem[]): void {
  for (const { item, range } of items) {
    item.sourceStart = range.sourceStart;
    item.sourceEnd = range.sourceEnd;
  }
}

function applyTextItem(text: string, item: FileEditPlan['items'][number]): string {
  if (text.slice(item.sourceStart, item.sourceEnd) !== item.removedText) {
    throw new Error('The transformed edit no longer matches its expected text.');
  }
  return text.slice(0, item.sourceStart) + item.insertedText + text.slice(item.sourceEnd);
}

function updateBaseline(file: FileEditPlan, current: NonNullable<FileEditPlan['current']>): void {
  const previous = file.base ?? file.current;
  const changesByteOrderMark = previous
    ? file.proposed.byteOrderMark !== previous.byteOrderMark
    : file.proposed.byteOrderMark !== current.byteOrderMark;
  const byteOrderMark = changesByteOrderMark ? file.proposed.byteOrderMark : current.byteOrderMark;
  file.base = current;
  file.current = current;
  file.currentPath = current.path;
  file.currentRevision = current.revision;
  const proposedText = composePendingText(file, current.text);
  file.proposed = snapshotForProposal(file, current, proposedText, byteOrderMark);
}

function composePendingText(file: FileEditPlan, baseText: string): string {
  let text = baseText;
  const pending = file.items
    .filter(item => item.kind === EditReviewItemKind.TEXT && item.decision === EditDecisionState.PENDING)
    .sort((left, right) => right.sourceStart - left.sourceStart);
  for (const item of pending) text = applyTextItem(text, item);
  return text;
}

function snapshotForProposal(
  file: FileEditPlan,
  current: NonNullable<FileEditPlan['current']>,
  text: string,
  byteOrderMark: boolean,
): NonNullable<FileEditPlan['current']> {
  const bytes = Buffer.from(text, 'utf8');
  const encoded = byteOrderMark ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
  return {
    path: file.targetPath,
    text,
    byteOrderMark,
    revision: createHash('sha256').update(encoded).digest('hex'),
    byteLength: encoded.length,
    mode: current.mode,
    identity: file.proposed.identity,
  };
}

function revisionOf(text: string, byteOrderMark: boolean): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha256')
    .update(byteOrderMark ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes)
    .digest('hex');
}
