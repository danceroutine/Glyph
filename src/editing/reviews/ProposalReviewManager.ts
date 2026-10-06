import { createHash } from 'node:crypto';
import type { Logger } from '../../observability/Logger.ts';
import { NullLogger } from '../../observability/NullLogger.ts';
import type { WorkspaceTextStore } from '../../workspace/WorkspaceTextStore.ts';
import { transformTextEditRanges } from '../documents/TextEditTransformer.ts';
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
 * Reviews remain independently addressable but retain arrival order so hosts
 * can present every actor's work as one continuous queue.
 */
export class ProposalReviewManager {
  private reviews: EditProposal[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly settledDecisions = new Map<
    string,
    { readonly reviewId: string; readonly decision: EditDecisionState }
  >();
  private readonly logger: Logger;

  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly store: ProposalReviewStore,
    logger: Logger = new NullLogger(),
    private readonly maxActiveReviews = 8,
  ) {
    this.logger = logger.forNamespace('editing.review');
  }

  get active(): EditProposal | undefined {
    return this.reviews[0];
  }
  get activeReviews(): readonly EditProposal[] {
    return [...this.reviews];
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

  async initialize(): Promise<void> {
    this.reviews = await this.store.load();
    if (this.reviews.length === 0) return;
    for (const review of this.reviews) {
      for (const file of review.files) await this.reconcile(review, file);
    }
    const recoveredIds = this.reviews.map(review => review.id);
    await this.persist();
    await this.logger.info('recovered', { proposalIds: recoveredIds, activeReviews: this.reviews.length });
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
        await this.store.save(this.reviews);
      } catch (error) {
        this.reviews.pop();
        throw error;
      }
      await this.logger.info('staged', {
        proposalId: proposal.id,
        files: proposal.files.length,
        queuePosition: this.reviews.length,
        activeReviews: this.reviews.length,
      });
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
      const reviews = this.requireReviews();
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
      await this.logger.info('rejected_all', { proposalIds: reviews.map(review => review.id) });
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
      await this.logger.info('item.rejected', { proposalId: review.id, fileId: file.id, itemId });
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
    const mutation = { undoGroupId: review.id };
    try {
      await this.logger.debug('revision.check', {
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
          item.decision = EditDecisionState.ACCEPTED;
          const result = await this.workspace.replace(
            file.currentPath,
            file.currentRevision,
            textChange.text,
            file.proposed.byteOrderMark,
            mutation,
          );
          applyTransformedRanges(textChange.transformedItems);
          updateBaseline(file, result);
          break;
        }
      }
      item.decision = EditDecisionState.ACCEPTED;
      file.applicability = EditApplicabilityState.READY;
      file.applyingItemId = null;
      await this.persist();
    } catch (error) {
      restoreFileState(file, applyingState);
      try {
        await this.reconcile(review, file);
        await this.persist();
      } catch {
        restoreFileState(file, applyingState);
      }
      await this.logger.error('item.failed', {
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
    await this.logger.info('item.accepted', {
      proposalId: review.id,
      fileId: file.id,
      itemId,
      revision: file.currentRevision,
    });
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
      if (rename && (await this.workspace.readOptional(file.targetPath))) throw this.stale(file);
    }
    await this.logger.forNamespace('accept_all').debug('preflight_passed', { proposalId: proposal.id });
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
    for (const review of reviews) {
      for (const file of review.files) {
        if (!file.items.some(item => item.decision === EditDecisionState.PENDING)) continue;
        const pendingRename = file.items.some(
          item => item.kind === EditReviewItemKind.RENAME && item.decision === EditDecisionState.PENDING,
        );
        const paths = pendingRename ? [file.currentPath, file.targetPath] : [file.currentPath];
        for (const path of new Set(paths)) {
          const key = path.normalize('NFC').toLocaleLowerCase('en-US');
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
    await this.logger.forNamespace('accept_all').debug('queue_preflight_passed', {
      proposalIds: reviews.map(review => review.id),
    });
  }

  private async reconcile(review: EditProposal, file: FileEditPlan): Promise<void> {
    const current = await this.workspace.readOptional(file.currentPath);
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
      const target = (await this.workspace.readOptional(file.targetPath)) ?? null;
      if (current && target && current.identity === target.identity && current.revision === file.currentRevision) {
        await this.workspace.delete(file.currentPath, current.revision, { undoGroupId: review.id });
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
      const textChange = planTextAcceptance(file, item);
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
    const current = await this.workspace.readOptional(file.currentPath);
    if (this.synchronizeSnapshot(file, current)) {
      await this.persist();
      return;
    }
    file.applicability = EditApplicabilityState.STALE;
    await this.persist();
    throw this.stale(file, current?.revision);
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
    await this.store.save(remaining);
    this.reviews = remaining;
    for (const review of settled) {
      for (const file of review.files) {
        for (const item of file.items) {
          this.settledDecisions.set(item.id, { reviewId: review.id, decision: item.decision });
        }
      }
      await this.logger.info('settled', { proposalId: review.id, activeReviews: remaining.length });
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
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}

function isSettled(review: EditProposal): boolean {
  return review.files.every(file => file.items.every(item => item.decision !== EditDecisionState.PENDING));
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
  const ranges = transformTextEditRanges(file.current.text, text, remaining);
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
