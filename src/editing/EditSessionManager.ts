import { createHash } from 'node:crypto';
import type { Logger } from '../observability/Logger.ts';
import { NullLogger } from '../observability/NullLogger.ts';
import type { WorkspaceTextStore } from '../workspace/WorkspaceTextStore.ts';
import { EditApplicabilityState } from './EditApplicabilityState.ts';
import { EditDecisionState } from './EditDecisionState.ts';
import { EditError } from './EditError.ts';
import { EditFailureReason } from './EditFailureReason.ts';
import { EditOperation } from './EditOperation.ts';
import type { EditProposal } from './EditProposal.ts';
import { EditReviewItemKind } from './EditReviewItemKind.ts';
import type { EditSessionStore } from './EditSessionStore.ts';
import type { FileEditPlan } from './FileEditPlan.ts';

export class EditSessionManager {
  private session: EditProposal | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly settledDecisions = new Map<string, EditDecisionState>();

  constructor(
    private readonly workspace: WorkspaceTextStore,
    private readonly store: EditSessionStore,
    private readonly logger: Logger = new NullLogger(),
    private readonly maxActiveSessions = 1,
  ) {}

  get active(): EditProposal | undefined { return this.session; }
  get(sessionId: string): EditProposal | undefined { return this.session?.id === sessionId ? this.session : undefined; }

  async initialize(): Promise<void> {
    this.session = await this.store.load();
    if (!this.session) return;
    for (const file of this.session.files) await this.reconcile(file);
    await this.persist();
    await this.logger.info('edit.session.recovered', { proposalId: this.session?.id });
  }

  async stage(proposal: EditProposal): Promise<void> {
    if (this.maxActiveSessions < 1 || this.session) {
      throw new EditError(EditFailureReason.ACTIVE_SESSION_LIMIT, 'Finish or reject the active edit session before staging another proposal.', {
        retry: 'Open /review and settle the pending items.',
      });
    }
    this.session = proposal;
    try { await this.store.save(proposal); }
    catch (error) { this.session = undefined; throw error; }
    await this.logger.info('edit.session.staged', { proposalId: proposal.id, files: proposal.files.length });
  }

  accept(itemId: string): Promise<void> { return this.decide(itemId, EditDecisionState.ACCEPTED); }
  reject(itemId: string): Promise<void> { return this.decide(itemId, EditDecisionState.REJECTED); }
  acceptInSession(sessionId: string, itemId: string): Promise<void> {
    this.requireSessionId(sessionId);
    return this.accept(itemId);
  }
  rejectInSession(sessionId: string, itemId: string): Promise<void> {
    this.requireSessionId(sessionId);
    return this.reject(itemId);
  }

  async acceptAll(): Promise<void> {
    return this.enqueue(async () => {
      const proposal = this.requireSession();
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
      const proposal = this.requireSession();
      for (const file of proposal.files) {
        for (const item of file.items) {
          if (item.decision === EditDecisionState.PENDING) item.decision = EditDecisionState.REJECTED;
        }
      }
      await this.persist();
      await this.logger.info('edit.session.rejected_all', { proposalId: proposal.id });
    });
  }

  private decide(itemId: string, decision: EditDecisionState): Promise<void> {
    return this.enqueue(async () => {
      const settled = this.settledDecisions.get(itemId);
      if (settled === decision) return;
      if (settled !== undefined) {
        throw new EditError(EditFailureReason.DECISION_CONFLICT, 'Review item already has the opposite decision.', { hunkId: itemId });
      }
      const proposal = this.requireSession();
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
      await this.logger.info('edit.item.rejected', { proposalId: this.session?.id, fileId: file.id, itemId });
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
    const mutation = this.session ? { undoGroupId: this.session.id } : {};
    try {
      await this.logger.debug('edit.cas.check', {
        proposalId: this.session?.id,
        fileId: file.id,
        path: file.currentPath,
        expectedRevision: file.currentRevision,
        itemId,
      });
      if (item.kind === EditReviewItemKind.CREATE) {
        const result = await this.workspace.create(file.targetPath, file.proposed.text, file.proposed.bom, file.proposed.mode, mutation);
        file.currentPath = result.path;
        file.currentRevision = result.revision;
        file.current = result;
      } else if (item.kind === EditReviewItemKind.DELETE) {
        if (!file.currentRevision) throw this.stale(file);
        await this.workspace.delete(file.currentPath, file.currentRevision, mutation);
        file.currentRevision = null;
        file.current = null;
      } else if (item.kind === EditReviewItemKind.RENAME) {
        if (!file.currentRevision) throw this.stale(file);
        const result = await this.workspace.rename(file.currentPath, file.targetPath, file.currentRevision, mutation);
        file.currentPath = result.path;
        file.currentRevision = result.revision;
        file.current = result;
      } else {
        if (!file.base || !file.currentRevision) throw this.stale(file);
        item.decision = EditDecisionState.ACCEPTED;
        const text = compose(file);
        const result = await this.workspace.replace(file.currentPath, file.currentRevision, text, file.proposed.bom, mutation);
        file.currentRevision = result.revision;
        file.current = result;
      }
      item.decision = EditDecisionState.ACCEPTED;
      file.applicability = EditApplicabilityState.READY;
      file.applyingItemId = null;
      await this.persist();
      await this.logger.info('edit.item.accepted', { proposalId: this.session?.id, fileId: file.id, itemId, revision: file.currentRevision });
    } catch (error) {
      if (error instanceof EditError && error.reason === EditFailureReason.STALE) file.applicability = EditApplicabilityState.STALE;
      else file.applicability = EditApplicabilityState.FAILED_RETRYABLE;
      if (item.kind === EditReviewItemKind.TEXT) item.decision = EditDecisionState.PENDING;
      file.applyingItemId = null;
      await this.persist();
      await this.logger.error('edit.item.failed', {
        proposalId: this.session?.id,
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
    await this.logger.debug('edit.accept_all.preflight_passed', { proposalId: proposal.id });
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
        await this.workspace.delete(file.currentPath, current.revision, this.session ? { undoGroupId: this.session.id } : {});
        after = target;
      } else if (!current) after = target;
    }
    const applied = item.kind === EditReviewItemKind.DELETE
      ? !current
      : item.kind === EditReviewItemKind.CREATE
        ? after?.revision === file.proposed.revision
        : item.kind === EditReviewItemKind.RENAME
          ? after?.revision === file.currentRevision && after.path === file.targetPath
          : after?.revision === revisionOf(composeWith(file, item.id), file.proposed.bom);
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
    const session = this.session;
    if (!session) return;
    const settled = session.files.every(file => file.items.every(item => item.decision !== EditDecisionState.PENDING));
    if (settled) {
      for (const file of session.files) for (const item of file.items) this.settledDecisions.set(item.id, item.decision);
      await this.store.clear();
      this.session = undefined;
      await this.logger.info('edit.session.settled', { proposalId: session.id });
    } else await this.store.save(session);
  }

  private stale(file: FileEditPlan, currentRevision?: string): EditError {
    return new EditError(EditFailureReason.STALE, 'The file changed outside this review session.', {
      fileId: file.id,
      path: file.currentPath,
      ...(currentRevision ? { currentRevision } : {}),
      retry: 'Leave this item pending and submit a fresh proposal from the current file.',
    });
  }

  private requireSession(): EditProposal {
    if (!this.session) throw new EditError(EditFailureReason.INCONSISTENT, 'There is no active edit session.');
    return this.session;
  }

  private requireSessionId(sessionId: string): EditProposal {
    const session = this.requireSession();
    if (session.id !== sessionId) throw new EditError(EditFailureReason.INCONSISTENT, 'Unknown edit session.', { source: sessionId });
    return session;
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

function revisionOf(text: string, bom: boolean): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha256').update(bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
    : bytes).digest('hex');
}
