import type { Logger } from '#src/observability/Logger.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import { WorkspaceReadLimitError } from '#src/workspace/WorkspaceReadLimitError.js';
import { EditError } from '#src/editing/errors/EditError.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import type { EditProposal } from '#src/editing/proposals/EditProposal.js';
import { FileEditPlan } from '#src/editing/proposals/FileEditPlan.js';
import { planTextRevert } from './AppliedTextEdit.ts';
import { EditApplicabilityState } from './EditApplicabilityState.ts';
import { EditDecisionState } from './EditDecisionState.ts';
import { EditReviewItemKind } from './EditReviewItemKind.ts';
import type { ProposalReviewCheckpoint } from './ProposalReviewCheckpoint.ts';

/**
 * Executes individual review decisions and recovers their interrupted workspace effects.
 *
 * Intent, workspace mutation, and completion form one protocol: splitting them across callers would let a
 * failed checkpoint masquerade as a failed edit. The manager serializes calls and owns the queue; this executor
 * owns workspace guards, application, reverts, and reconciliation, requesting checkpoints at each boundary.
 */
export class ProposalReviewExecutor {
  /** Accepts only execution dependencies; queue collections and persistence bookkeeping stay with the manager. */
  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly checkpoint: ProposalReviewCheckpoint,
    private readonly onDecision: (reviewId: string) => void,
    private readonly logger: Logger,
    private readonly maxAllowableReadBytes: number,
  ) {}

  /** Recovers each file before the manager publishes a recovered queue, retaining unresolvable changes for review. */
  async recover(review: EditProposal): Promise<void> {
    for (const file of review.files) {
      if (file.items.some(item => item.appliedText) && (file.applyingItemId === null || file.applyingItemId === '')) {
        if (file.items.some(item => item.appliedText?.state === 'reverting'))
          file.applicability = EditApplicabilityState.STALE;
        continue;
      }
      if (file.automatic?.state === 'applied') continue;
      if (file.automatic?.state === 'reverting') {
        file.applicability = EditApplicabilityState.STALE;
        continue;
      }
      await this.reconcile(review, file);
      if (
        file.automatic?.state === 'applying' &&
        file.items.find(item => item.id === file.automatic?.itemId)?.decision === EditDecisionState.ACCEPTED
      ) {
        file.automatic.state = 'applied';
        file.automatic.appliedRevision = file.currentRevision;
      }
    }
  }

  /** Keeps or reverses an automatic structural change only after its intent and workspace evidence agree. */
  async settleStructural(review: EditProposal, itemId: string, keep: boolean, comment?: string): Promise<void> {
    const reviewId = review.id;
    const file = review.files.find(file => file.automatic?.itemId === itemId);
    if (!file?.automatic) throw new EditError(EditFailureReason.INCONSISTENT, 'Unknown applied file change.');
    const automatic = file.automatic;
    if (comment !== undefined && (!comment.trim() || comment.length > 4000))
      throw new EditError(
        EditFailureReason.INCONSISTENT,
        'Review comments must contain between 1 and 4000 characters.',
      );
    if (['kept', 'reverted'].includes(automatic.state)) return;
    if (automatic.state === 'applying') {
      const hadIntent = file.applyingItemId !== null;
      if (hadIntent) {
        await this.reconcile(review, file);
        await this.checkpoint.saveOutcome();
      }
      if (automatic.state === 'applying') {
        if (keep) await this.applyDecision(review, file, itemId, EditDecisionState.ACCEPTED);
        else {
          if (hadIntent && file.applicability !== EditApplicabilityState.READY) throw this.stale(file);
          const item = file.items.find(item => item.id === itemId)!;
          automatic.state = 'reverted';
          item.decision = EditDecisionState.REJECTED;
          item.rejectionComment = comment?.trim();
          try {
            await this.checkpoint.saveOutcome();
          } catch (error) {
            automatic.state = 'applying';
            item.decision = EditDecisionState.PENDING;
            throw error;
          }
          this.onDecision(reviewId);
          return;
        }
      }
    }
    if (keep && automatic.state === 'reverting') throw this.stale(file);
    if (keep) {
      automatic.state = 'kept';
      try {
        await this.checkpoint.saveOutcome();
      } catch (error) {
        automatic.state = 'applied';
        throw error;
      }
    } else {
      const operationId = `${review.id}:${itemId}:revert`;
      const mutation = { operationId, undoGroupId: operationId, save: true };
      const wasReverting = automatic.state === 'reverting';
      automatic.state = 'reverting';
      file.items.find(item => item.id === itemId)!.rejectionComment = comment?.trim();
      try {
        await this.checkpoint.saveIntent();
      } catch (error) {
        automatic.state = wasReverting ? 'reverting' : 'applied';
        throw error;
      }
      const current = await this.workspace.readOptional(file.currentPath, { maxBytes: this.maxAllowableReadBytes });
      if (file.operation === EditOperation.CREATE) {
        if (current) {
          if (current.revision !== automatic.appliedRevision) throw this.stale(file, current.revision);
          await this.workspace.delete(file.currentPath, current.revision, mutation);
        }
        file.current = null;
        file.currentRevision = null;
      } else if (file.operation === EditOperation.DELETE) {
        const before = automatic.before!;
        if (current) {
          if (current.revision !== before.revision || !wasReverting) throw this.stale(file, current.revision);
          file.current = current;
        } else
          file.current = await this.workspace.create(
            file.sourcePath,
            before.text,
            before.byteOrderMark,
            before.mode,
            mutation,
          );
        file.currentRevision = file.current.revision;
      } else {
        if (await this.workspace.exists(file.sourcePath)) {
          const restored = await this.workspace.read(file.sourcePath);
          if (!wasReverting || current || restored.revision !== automatic.appliedRevision) throw this.stale(file);
          file.current = restored;
        } else {
          if (!current || current.revision !== automatic.appliedRevision) throw this.stale(file, current?.revision);
          file.current = await this.workspace.rename(file.currentPath, file.sourcePath, current.revision, mutation);
        }
        file.currentPath = file.sourcePath;
        file.currentRevision = file.current.revision;
      }
      automatic.state = 'reverted';
      file.items.find(item => item.id === itemId)!.decision = EditDecisionState.REJECTED;
      file.applicability = EditApplicabilityState.READY;
      this.checkpoint.markWorkspaceChanged();
      await this.checkpoint.saveOutcome();
    }
    this.onDecision(reviewId);
  }

  /** Separates the human decision from an already-applied edit, preserving later user edits during reverts. */
  async settleText(
    review: EditProposal,
    file: FileEditPlan,
    item: FileEditPlan['items'][number],
    decision: EditDecisionState,
    comment?: string,
  ): Promise<void> {
    const edit = item.appliedText!;
    if (['kept', 'reverted'].includes(edit.state)) {
      if (item.decision !== decision)
        throw new EditError(EditFailureReason.DECISION_CONFLICT, 'Review item already has the opposite decision.');
      return;
    }
    if (comment !== undefined && (!comment.trim() || comment.length > 4000))
      throw new EditError(
        EditFailureReason.INCONSISTENT,
        'Review comments must contain between 1 and 4000 characters.',
      );
    if (file.applyingItemId !== null && file.applyingItemId !== '') {
      await this.reconcile(review, file);
      await this.checkpoint.saveOutcome();
    }
    if (decision === EditDecisionState.ACCEPTED) {
      if (edit.state === 'reverting') throw this.stale(file);
      if (edit.state === 'applying') await this.applyDecision(review, file, item.id, decision);
      edit.state = 'kept';
      try {
        await this.checkpoint.saveOutcome();
      } catch (error) {
        edit.state = 'applied';
        throw error;
      }
    } else {
      const current = await this.workspace.read(file.currentPath, { maxBytes: this.maxAllowableReadBytes });
      if (edit.state === 'applying') {
        // A failed proposal can be dismissed only when its side effect is absent.
        if (edit.before && current.revision !== edit.before.revision) throw this.stale(file, current.revision);
        const oldComment = item.rejectionComment;
        edit.state = 'reverted';
        item.decision = decision;
        item.rejectionComment = comment?.trim();
        try {
          await this.checkpoint.saveOutcome();
        } catch (error) {
          edit.state = 'applying';
          item.decision = EditDecisionState.PENDING;
          item.rejectionComment = oldComment;
          throw error;
        }
      } else {
        let target = edit.revertTarget;
        if (edit.state !== 'reverting') {
          const inverse = planTextRevert(edit, current);
          if (!inverse) throw this.stale(file, current.revision);
          target = file.snapshotFor(current, inverse.text, inverse.byteOrderMark);
          edit.revertTarget = target;
          edit.state = 'reverting';
          file.current = current;
          file.currentRevision = current.revision;
          item.rejectionComment = comment?.trim();
          try {
            await this.checkpoint.saveIntent();
          } catch (error) {
            edit.state = 'applied';
            edit.revertTarget = null;
            throw error;
          }
        }
        if (!target) throw this.stale(file);
        let restored = current;
        if (current.revision !== target.revision) {
          if (current.revision !== file.currentRevision) throw this.stale(file, current.revision);
          const operationId = `${review.id}:${item.id}:revert`;
          restored = await this.workspace.replace(
            file.currentPath,
            current.revision,
            target.text,
            target.byteOrderMark,
            {
              operationId,
              undoGroupId: operationId,
              save: true,
            },
          );
        }
        file.current = restored;
        file.currentRevision = restored.revision;
        file.applicability = EditApplicabilityState.READY;
        edit.state = 'reverted';
        item.decision = decision;
        this.checkpoint.markWorkspaceChanged();
        await this.checkpoint.saveOutcome();
      }
    }
    this.onDecision(review.id);
  }

  /** Carries one decision through durable intent, guarded workspace I/O, and recoverable completion. */
  async applyDecision(
    review: EditProposal,
    file: FileEditPlan,
    itemId: string,
    decision: EditDecisionState,
    comment?: string,
  ): Promise<void> {
    const item = file.items.find(candidate => candidate.id === itemId)!;
    if (file.applyingItemId !== null && file.applyingItemId !== '') {
      await this.reconcile(review, file);
      await this.checkpoint.saveOutcome();
    }
    if (item.decision === decision) return;
    if (item.decision !== EditDecisionState.PENDING) {
      throw new EditError(EditFailureReason.DECISION_CONFLICT, 'Review item already has the opposite decision.', {
        fileId: file.id,
        hunkId: item.id,
      });
    }
    if (decision === EditDecisionState.REJECTED) {
      if (comment !== undefined && (typeof comment !== 'string' || !comment.trim() || comment.length > 4000)) {
        throw new EditError(
          EditFailureReason.INCONSISTENT,
          'Review comments must contain between 1 and 4000 characters.',
          { hunkId: item.id },
        );
      }
      const previousComment = item.rejectionComment;
      item.rejectionComment = comment?.trim();
      item.decision = decision;
      try {
        await this.checkpoint.saveOutcome();
      } catch (error) {
        item.decision = EditDecisionState.PENDING;
        item.rejectionComment = previousComment;
        throw error;
      }
      await this.log('info', 'item.rejected', { proposalId: review.id, fileId: file.id, itemId });
      this.onDecision(review.id);
      return;
    }
    await this.synchronize(file);
    if (item.appliedText) item.appliedText.before = file.current ? structuredClone(file.current) : null;
    file.applicability = EditApplicabilityState.APPLYING;
    file.applyingItemId = item.id;
    try {
      await this.checkpoint.saveIntent();
    } catch (error) {
      file.applicability = EditApplicabilityState.FAILED_RETRYABLE;
      file.applyingItemId = null;
      throw error;
    }
    const applyingState = file.captureState();
    const operationId = `${review.id}:${file.id}:${item.id}`;
    const mutation = { operationId, undoGroupId: operationId, save: true };
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
          this.checkpoint.markWorkspaceChanged();
          file.currentPath = result.path;
          file.currentRevision = result.revision;
          file.current = result;
          break;
        }
        case EditReviewItemKind.DELETE:
          if (file.currentRevision === null || file.currentRevision === '') throw this.stale(file);
          await this.workspace.delete(file.currentPath, file.currentRevision, mutation);
          this.checkpoint.markWorkspaceChanged();
          file.currentRevision = null;
          file.current = null;
          break;
        case EditReviewItemKind.RENAME: {
          if (file.currentRevision === null || file.currentRevision === '') throw this.stale(file);
          const result = await this.workspace.rename(file.currentPath, file.targetPath, file.currentRevision, mutation);
          this.checkpoint.markWorkspaceChanged();
          file.currentPath = result.path;
          file.updateBaseline(result);
          break;
        }
        case EditReviewItemKind.TEXT: {
          if (!file.base || !file.current || file.currentRevision === null || file.currentRevision === '')
            throw this.stale(file);
          const textChange = file.planTextAcceptance(item);
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
          this.checkpoint.markWorkspaceChanged();
          const previous = file.clone();
          item.decision = EditDecisionState.ACCEPTED;
          file.current = result;
          file.currentPath = result.path;
          file.currentRevision = result.revision;
          file.applyingItemId = null;
          file.applicability = EditApplicabilityState.STALE;
          const actual = previous.planTextAcceptance(item, result.text);
          if (actual) {
            file.applyTransformedRanges(actual.transformedItems);
            file.updateBaseline(result);
          } else {
            // Keep the old base/ranges as conflict evidence, but checkpoint the
            // observed current document and the completed item's acceptance.
            applicability = EditApplicabilityState.STALE;
          }
          break;
        }
      }
      item.decision = EditDecisionState.ACCEPTED;
      if (item.appliedText) {
        item.appliedText.after = file.current ? structuredClone(file.current) : null;
        item.appliedText.state = 'applied';
      }
      if (file.automatic?.itemId === item.id) {
        file.automatic.state = 'applied';
        file.automatic.appliedRevision = file.currentRevision;
      }
      file.applicability = applicability;
      file.applyingItemId = null;
      await this.checkpoint.saveOutcome();
    } catch (error) {
      if (this.checkpoint.hasPendingCheckpoint) {
        // The workspace's observed result is stronger evidence than predicted
        // bytes. Keep it across save failures and block decisions until saved.
        try {
          await this.checkpoint.saveOutcome();
        } catch {
          /* Retried by the next queued operation. */
        }
      } else {
        file.restoreState(applyingState);
        try {
          await this.reconcile(review, file);
          await this.checkpoint.saveOutcome();
        } catch {
          file.restoreState(applyingState);
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
    this.onDecision(review.id);
  }

  /** Synchronizes one proposal before execution so stale files or occupied rename targets fail before mutation. */
  async preflight(proposal: EditProposal): Promise<void> {
    for (const file of proposal.files) {
      if (file.applyingItemId !== null && file.applyingItemId !== '') {
        await this.reconcile(proposal, file);
        await this.checkpoint.saveOutcome();
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

  /**
   * Re-aligns a plan with the workspace after something happened outside its view: a restart, an
   * interrupted or failed mutation, or edits made while the review sat in the queue. Every decision on a
   * file with an outstanding intent passes through here first, so no decision is ever based on a guess
   * about what is on disk.
   *
   * The outcome is either a plan that is safe to act on or one marked stale. Unreviewable files never
   * throw, because one broken file must not block recovery, bulk rejection, or the rest of the queue.
   */
  async reconcile(review: EditProposal, file: FileEditPlan): Promise<void> {
    // With no write in flight and the file expected to be absent, the only question is whether the path is
    // still free. Reading content here would spend the read budget on a file the plan never relied on.
    if (file.currentRevision === null && (file.applyingItemId === null || file.applyingItemId === '')) {
      if (!(await this.synchronizeNewFile(file))) file.applicability = EditApplicabilityState.STALE;
      return;
    }
    let current: FileEditPlan['current'] | undefined;
    try {
      // This runs for every queued file at startup. Bound each read so one huge replacement file cannot
      // exhaust memory before the user even sees the queue.
      current = await this.workspace.readOptional(file.currentPath, { maxBytes: this.maxAllowableReadBytes });
    } catch (error) {
      if (!isUnreviewableSnapshot(error)) throw error;
      // A path replaced by a directory, binary file, or disallowed resource is
      // stale, not absent, as is content beyond the recovery read budget or a
      // file identity that changed while opening. None proves a pending DELETE ran.
      // Retain the reviewed text so the user can inspect and reject the proposal.
      // Dropping the unresolvable intent stops every later decision from re-running this same failed recovery.
      file.applicability = EditApplicabilityState.STALE;
      file.applyingItemId = null;
      return;
    }
    // An interrupted write may have landed. Check for that before treating the difference as outside edits.
    // Otherwise our own change would look foreign and mark the file stale, or a landed acceptance would stay
    // pending and be applied a second time.
    const applying =
      file.applyingItemId !== null && file.applyingItemId !== ''
        ? file.items.find(item => item.id === file.applyingItemId)
        : undefined;
    if (applying) {
      const recovered = await this.reconcileApplying(review, file, applying, current);
      if (recovered) return;
    }
    // The write did not land, or could not be proven to. Treat the disk as authoritative and try to carry the
    // pending hunks over whatever it holds, as for any concurrent edit.
    if (file.synchronizeAgainst(current)) return;
    // The pending hunks no longer fit the file. Fail closed: the human can still inspect and reject, but
    // nothing will be written on outdated assumptions.
    // Follow-up: provide an explicit human recovery path for this stale state.
    file.applicability = EditApplicabilityState.STALE;
    file.applyingItemId = null;
  }

  /** Proves whether durable intent landed before treating workspace differences as unrelated human edits. */
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
        target = (await this.workspace.readOptional(file.targetPath, { maxBytes: this.maxAllowableReadBytes })) ?? null;
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
            : after?.revision === FileEditPlan.revisionOf(file.composeWith(item.id), file.proposed.byteOrderMark);
    if (!applied) return false;
    item.decision = EditDecisionState.ACCEPTED;
    if (item.kind === EditReviewItemKind.TEXT && after) {
      const textChange = file.planTextAcceptance(item, after.text);
      if (!textChange) return false;
      file.applyTransformedRanges(textChange.transformedItems);
      file.updateBaseline(after);
    } else {
      file.current = after;
      file.currentPath = after?.path ?? file.currentPath;
      file.currentRevision = after?.revision ?? null;
      if (item.kind === EditReviewItemKind.RENAME && after) file.updateBaseline(after);
    }
    if (item.appliedText) {
      item.appliedText.after = after ? structuredClone(after) : null;
      item.appliedText.state = 'applied';
    }
    if (file.automatic?.itemId === item.id) {
      file.automatic.state = 'applied';
      file.automatic.appliedRevision = file.currentRevision;
    }
    file.applicability = EditApplicabilityState.READY;
    file.applyingItemId = null;
    return true;
  }

  /** Checkpoints fresh workspace observations so a later failure cannot revive assumptions already known to be stale. */
  private async synchronize(file: FileEditPlan): Promise<void> {
    if (file.currentRevision === null) {
      const ready = await this.synchronizeNewFile(file);
      if (!ready) file.applicability = EditApplicabilityState.STALE;
      await this.checkpoint.saveOutcome();
      if (!ready) throw this.stale(file);
      return;
    }
    let current: FileEditPlan['current'] | undefined;
    try {
      current = await this.workspace.readOptional(file.currentPath, { maxBytes: this.maxAllowableReadBytes });
    } catch (error) {
      if (!isUnreviewableSnapshot(error)) throw error;
      file.applicability = EditApplicabilityState.STALE;
      await this.checkpoint.saveOutcome();
      throw this.stale(file);
    }
    if (file.synchronizeAgainst(current)) {
      await this.checkpoint.saveOutcome();
      return;
    }
    file.applicability = EditApplicabilityState.STALE;
    await this.checkpoint.saveOutcome();
    throw this.stale(file, current?.revision);
  }

  /**
   * Synchronizes intents that operate on a new file against the workspace. The expectation is that the file does not exist.
   * @param file - The file edit plan to synchronize.
   * @returns false if the file exists, indicating that the intent to create the file at that location is now stale
   */
  private async synchronizeNewFile(file: FileEditPlan): Promise<boolean> {
    // Pending CREATE only needs proof that the path is absent. Content is needed
    // solely when recovering an applying CREATE to recognize its expected hash.
    try {
      if (await this.workspace.exists(file.currentPath)) return false;
    } catch (error) {
      if (!isUnreviewableSnapshot(error)) throw error;
      return false;
    }
    return file.synchronizeAgainst(undefined);
  }

  /** Routes execution diagnostics through the same isolation used by preflight logging. */
  private log(level: 'debug' | 'info' | 'error', message: string, data?: unknown): Promise<void> {
    return this.logWith(this.logger, level, message, data);
  }

  /** Diagnostics may fail independently of storage and must never turn a successful edit into a recovery path. */
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

  /** Gives recovery guidance that accounts for changes already applied to the workspace. */
  private stale(file: FileEditPlan, currentRevision?: string): EditError {
    return new EditError(EditFailureReason.STALE, 'The file changed outside this proposal review.', {
      fileId: file.id,
      path: file.currentPath,
      ...(currentRevision !== undefined && currentRevision !== '' ? { currentRevision } : {}),
      retry:
        file.automatic || file.items.some(item => item.appliedText)
          ? 'Keep this change or revert newer overlapping changes first.'
          : 'Leave this item pending and submit a fresh proposal from the current file.',
    });
  }
}

function isUnreviewableSnapshot(error: unknown): boolean {
  return (
    error instanceof WorkspaceReadLimitError ||
    (error instanceof EditError &&
      (error.reason === EditFailureReason.UNSUPPORTED || error.reason === EditFailureReason.STALE))
  );
}
