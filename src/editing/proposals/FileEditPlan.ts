import { createHash } from 'node:crypto';
import { transformTextEditRanges } from '#src/editing/documents/transformTextEditRanges.js';
import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import type { EditReviewItem } from '#src/editing/reviews/EditReviewItem.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import { EditOperation } from './EditOperation.ts';

export interface FileEditPlanRecord {
  /**
   * Stable key linking review items, UI previews, and model-facing receipts back to this file. Also seeds
   * workspace operation and undo-group IDs so a retried mutation is recognized as the same operation.
   */
  readonly id: string;
  /**
   * The agent's declared intent. Only UPDATE and RENAME can rebase pending hunks over outside edits; a
   * CREATE or DELETE whose file has changed on disk goes stale instead.
   * TODO: Ensure DELETE can be applied on a stale file.
   */
  readonly operation: EditOperation;
  /** The path named by the agent, retained for policy checks, receipts, and structural reverts. */
  readonly sourcePath: string;
  /** The intended destination, equal to `sourcePath` unless the operation renames the file. */
  readonly targetPath: string;
  /**
   * State for a structural change applied before human review. Workspace application and the later human
   * keep-or-revert decision remain separate, durable transitions.
   */
  automatic?:
    | {
        /** The structural review item that was auto-applied and still awaits a human decision. */
        readonly itemId: string;
        /**
         * The file before the structural change, used to restore deletes and render replaced content.
         * `null` when the change created the file.
         * TODO: Avoid retaining duplicate large snapshots if this becomes a material memory cost.
         */
        readonly before: WorkspaceTextSnapshot | null;
        /**
         * Persisted transition state. Recovery marks interrupted reverts stale instead of guessing whether
         * the workspace mutation landed; `kept` and `reverted` are final human decisions.
         */
        state: 'applying' | 'applied' | 'reverting' | 'reverted' | 'kept';
        /** Revision produced by application and required by a later safe revert. */
        appliedRevision: string | null;
      }
    | undefined;
  /**
   * Snapshot to which pending hunk offsets refer. It advances after accepted hunks or successful rebases,
   * while a failed rebase preserves the old snapshot as conflict evidence. `null` for CREATE.
   */
  base: WorkspaceTextSnapshot | null;
  /**
   * The file produced by accepting every pending hunk over `base`, recomputed whenever the baseline moves.
   * It also carries the encoding and mode requested by the proposal.
   */
  proposed: WorkspaceTextSnapshot;
  /** Individually decidable changes that let the human accept or reject the proposal hunk by hunk. */
  readonly items: EditReviewItem[];
  /**
   * Last observed workspace snapshot, kept separate from the agent's `base` assumptions for drift detection,
   * revert planning, and review previews. `null` when the file is absent.
   */
  current: WorkspaceTextSnapshot | null;
  /**
   * Write-ahead marker persisted before an accepted item mutates the workspace, allowing recovery to prove
   * whether an interrupted write landed without applying it twice.
   */
  applyingItemId: string | null;
  /**
   * Parent directories created while accepting CREATE or RENAME, reserved for future revert cleanup.
   * TODO: Populate this field when the workspace store exposes created directory information.
   */
  createdDirectories: string[];
  /**
   * Whether decisions can currently be applied. STALE prevents writes based on invalid assumptions;
   * FAILED_RETRYABLE records a checkpoint failure that occurred before any workspace mutation.
   * TODO: Provide an explicit human recovery path for stale plans.
   */
  applicability: EditApplicabilityState;
  /** Current workspace path, which moves from source to target when a rename is accepted. */
  currentPath: string;
  /**
   * Exact-byte revision required by optimistic workspace mutations. `null` means the file is expected not
   * to exist, as with a pending CREATE or accepted DELETE.
   */
  currentRevision: string | null;
}

interface TransformedItem {
  readonly item: EditReviewItem;
  readonly range: { readonly sourceStart: number; readonly sourceEnd: number };
}

export interface FileEditPlanState {
  readonly base: WorkspaceTextSnapshot | null;
  readonly proposed: WorkspaceTextSnapshot;
  readonly current: WorkspaceTextSnapshot | null;
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

export interface PlannedTextAcceptance {
  readonly text: string;
  readonly transformedItems: readonly TransformedItem[];
}

/**
 * One file's share of an agent's edit proposal and its live, persisted review state.
 *
 * The plan retains what the agent saw (`base`), what it wants (`proposed`), and the last workspace state
 * observed (`current`). It owns the coordinated transitions that keep those snapshots, revisions, and hunk
 * ranges aligned while a human reviews the proposal and continues editing the file.
 *
 * `EditProposalService` compiles plans, `ProposalReviewManager` coordinates workspace I/O and checkpoints,
 * and persistence converts plans through `FileEditPlanRecord`. Every field therefore remains serializable
 * and meaningful after crash recovery even though the live object has domain behavior.
 */
export class FileEditPlan implements FileEditPlanRecord {
  readonly id: string;
  readonly operation: EditOperation;
  readonly sourcePath: string;
  readonly targetPath: string;
  automatic?: FileEditPlanRecord['automatic'];
  base: WorkspaceTextSnapshot | null;
  proposed: WorkspaceTextSnapshot;
  readonly items: EditReviewItem[];
  current: WorkspaceTextSnapshot | null;
  applyingItemId: string | null;
  createdDirectories: string[];
  applicability: EditApplicabilityState;
  currentPath: string;
  currentRevision: string | null;

  /**
   * Keeps construction behind {@link FileEditPlan.from} so every boundary that receives persisted data uses
   * the same hydration path, while callers that already hold a live plan retain its object identity.
   */
  private constructor(record: FileEditPlanRecord) {
    this.id = record.id;
    this.operation = record.operation;
    this.sourcePath = record.sourcePath;
    this.targetPath = record.targetPath;
    this.automatic = record.automatic;
    this.base = record.base;
    this.proposed = record.proposed;
    this.items = record.items;
    this.current = record.current;
    this.applyingItemId = record.applyingItemId;
    this.createdDirectories = record.createdDirectories;
    this.applicability = record.applicability;
    this.currentPath = record.currentPath;
    this.currentRevision = record.currentRevision;
  }

  /**
   * Establishes the live domain object at creation and persistence boundaries. Returning an existing plan
   * unchanged is important because the review manager and UI may both retain references to its mutable items.
   */
  static from(record: FileEditPlanRecord | FileEditPlan): FileEditPlan {
    return record instanceof FileEditPlan ? record : new FileEditPlan(record);
  }

  /**
   * Computes revisions from the exact bytes a workspace write would produce. Including the byte order mark
   * keeps crash recovery and optimistic concurrency aligned with the workspace store's revision contract.
   */
  static revisionOf(text: string, byteOrderMark: boolean): string {
    const bytes = Buffer.from(text, 'utf8');
    return createHash('sha256')
      .update(byteOrderMark ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes)
      .digest('hex');
  }

  /**
   * Refuses to compose an edit whose recorded source text no longer matches. Range transformation can move
   * offsets, but it must never turn a stale hunk into an unchecked replacement.
   */
  private static applyTextItem(text: string, item: EditReviewItem): string {
    if (text.slice(item.sourceStart, item.sourceEnd) !== item.removedText) {
      throw new Error('The transformed edit no longer matches its expected text.');
    }
    return text.slice(0, item.sourceStart) + item.insertedText + text.slice(item.sourceEnd);
  }

  /**
   * Exposes an explicit persistence shape so serialized checkpoints never depend on class prototypes or on
   * future implementation-only members added to the live plan.
   */
  toRecord(): FileEditPlanRecord {
    return {
      id: this.id,
      operation: this.operation,
      sourcePath: this.sourcePath,
      targetPath: this.targetPath,
      ...(this.automatic ? { automatic: this.automatic } : {}),
      base: this.base,
      proposed: this.proposed,
      items: this.items,
      current: this.current,
      applyingItemId: this.applyingItemId,
      createdDirectories: this.createdDirectories,
      applicability: this.applicability,
      currentPath: this.currentPath,
      currentRevision: this.currentRevision,
    };
  }

  /**
   * Captures every coordinated mutable field before a fallible transition. A workspace mutation or the
   * second half of a rebase may fail after earlier fields changed, so rolling back only one field would leave
   * snapshots, revisions, item ranges, and decisions describing different document versions.
   */
  captureState(): FileEditPlanState {
    return {
      base: this.base,
      proposed: this.proposed,
      current: this.current,
      applyingItemId: this.applyingItemId,
      createdDirectories: [...this.createdDirectories],
      applicability: this.applicability,
      currentPath: this.currentPath,
      currentRevision: this.currentRevision,
      items: this.items.map(item => ({
        id: item.id,
        sourceStart: item.sourceStart,
        sourceEnd: item.sourceEnd,
        decision: item.decision,
      })),
    };
  }

  /**
   * Rolls a failed transition back in place. Preserving the plan, item array, and item object identities lets
   * manager and UI references remain valid while restoring the last coherent checkpoint by stable item ID.
   */
  restoreState(state: FileEditPlanState): void {
    this.base = state.base;
    this.proposed = state.proposed;
    this.current = state.current;
    this.applyingItemId = state.applyingItemId;
    this.createdDirectories = [...state.createdDirectories];
    this.applicability = state.applicability;
    this.currentPath = state.currentPath;
    this.currentRevision = state.currentRevision;
    for (const itemState of state.items) {
      const item = this.items.find(candidate => candidate.id === itemState.id);
      if (!item) continue;
      item.sourceStart = itemState.sourceStart;
      item.sourceEnd = itemState.sourceEnd;
      item.decision = itemState.decision;
    }
  }

  /**
   * Creates an independent live plan for speculative work. Queue preflight and editor-normalization checks
   * must be able to transform ranges without leaking tentative state into the durable review.
   */
  clone(): FileEditPlan {
    return new FileEditPlan(structuredClone(this.toRecord()));
  }

  /**
   * Restricts drift rebasing to operations whose meaning survives unrelated edits to an existing document.
   * CREATE and DELETE describe structural preconditions instead, so rebasing them could conceal a conflict.
   */
  canRebase(): boolean {
    return this.operation === EditOperation.UPDATE || this.operation === EditOperation.RENAME;
  }

  /**
   * Identifies plans that queue preflight may safely combine into one virtual document. Mixed or structural
   * changes need their own path-conflict handling because text-range transformation cannot model them.
   */
  canBatchTextChanges(): boolean {
    return (
      this.operation === EditOperation.UPDATE &&
      this.items.some(item => item.decision === EditDecisionState.PENDING) &&
      this.items
        .filter(item => item.decision === EditDecisionState.PENDING)
        .every(item => item.kind === EditReviewItemKind.TEXT)
    );
  }

  /**
   * Reconstructs the exact bytes expected after one interrupted text acceptance. Recovery compares this
   * prediction with the workspace revision to decide whether the write landed before the process stopped.
   */
  composeWith(itemId: string): string {
    const item = this.items.find(candidate => candidate.id === itemId);
    if (!item || item.kind !== EditReviewItemKind.TEXT || !this.current) return this.current?.text ?? '';
    return FileEditPlan.applyTextItem(this.current.text, item);
  }

  /**
   * Plans one text acceptance without mutating this plan.
   *
   * Separating prediction from commitment lets the manager persist write intent before touching the workspace.
   * When an editor returns normalized text, the same planning step moves the other pending ranges over the
   * observed bytes rather than assuming the predicted bytes landed unchanged.
   *
   * @param item - Pending text item to apply to the observed current snapshot.
   * @param actualText - Optional text actually produced by an editor-backed mutation. Remaining ranges follow
   * this observed result instead of the predicted replacement bytes.
   * @returns Predicted text and transformed ranges, or `undefined` when the edit no longer applies exactly.
   */
  planTextAcceptance(item: EditReviewItem, actualText?: string): PlannedTextAcceptance | undefined {
    if (!this.current || item.kind !== EditReviewItemKind.TEXT) return undefined;
    let text: string;
    try {
      text = FileEditPlan.applyTextItem(this.current.text, item);
    } catch {
      return undefined;
    }
    const remaining = this.items.filter(
      candidate =>
        candidate.id !== item.id &&
        candidate.kind === EditReviewItemKind.TEXT &&
        candidate.decision === EditDecisionState.PENDING,
    );
    const ranges = transformTextEditRanges(this.current.text, actualText ?? text, remaining);
    if (!ranges) return undefined;
    return {
      text,
      transformedItems: remaining.map((candidate, index) => ({ item: candidate, range: ranges[index]! })),
    };
  }

  /**
   * Commits previously calculated ranges by stable ID because speculative calculations may come from a cloned
   * plan. Looking up the live items avoids replacing objects retained by review projections and UI state.
   */
  applyTransformedRanges(items: readonly TransformedItem[]): void {
    for (const { item, range } of items) {
      const target = this.items.find(candidate => candidate.id === item.id)!;
      target.sourceStart = range.sourceStart;
      target.sourceEnd = range.sourceEnd;
    }
  }

  /**
   * Rebases every pending text item from one document version to another, mutating their ranges in place.
   *
   * All ranges are calculated before any are committed, so an ambiguous hunk leaves the plan untouched and
   * the caller can fail closed with the original conflict evidence intact.
   *
   * @param previousText - Document text to which current item ranges refer.
   * @param currentText - New document text onto which pending ranges should move.
   * @returns Whether every pending range could be transformed without ambiguity.
   */
  rebasePendingTextItems(previousText: string, currentText: string): boolean {
    const items = this.items.filter(
      item => item.kind === EditReviewItemKind.TEXT && item.decision === EditDecisionState.PENDING,
    );
    const ranges = transformTextEditRanges(previousText, currentText, items);
    if (!ranges) return false;
    this.applyTransformedRanges(items.map((item, index) => ({ item, range: ranges[index]! })));
    return true;
  }

  /**
   * Advances a speculative plan to a virtual queue snapshot. This isolates cross-proposal path preflight from
   * the durable plan while using the same range and baseline rules as a real synchronization.
   */
  rebaseToSnapshot(current: WorkspaceTextSnapshot): boolean {
    if (!this.current || !this.rebasePendingTextItems(this.current.text, current.text)) return false;
    this.updateBaseline(current);
    return true;
  }

  /**
   * Materializes the virtual result used to preflight multiple queued text proposals against one path. The
   * method requires an observed document because pending offsets have no safe meaning without that baseline.
   */
  simulatePendingTextChanges(): WorkspaceTextSnapshot {
    if (!this.current) throw new Error('Cannot simulate text changes without a current document.');
    const text = this.composePendingText(this.current.text);
    return this.snapshotFor(this.current, text, this.proposed.byteOrderMark);
  }

  /**
   * Adopts a freshly observed snapshot as the plan's new starting point, carrying pending hunks over edits
   * made since the previous observation. Both rebases must succeed before the original conflict evidence is
   * replaced; otherwise the entire in-memory transition is rolled back.
   *
   * The two stages matter after crash recovery: persisted `base` may precede the last observed `current`, and
   * the workspace may then have advanced again. Treating both moves as one transaction prevents a successful
   * first rebase from surviving when the second cannot be placed safely.
   *
   * @returns `false` when pending hunks cannot be placed with certainty and the caller must mark the plan stale.
   */
  synchronizeAgainst(current: WorkspaceTextSnapshot | undefined): boolean {
    if (this.currentRevision === null) {
      if (current !== undefined) return false;
      this.current = null;
      this.applicability = EditApplicabilityState.READY;
      this.applyingItemId = null;
      return true;
    }
    if (!current || !this.current) return false;

    const previous = this.captureState();
    let synchronized = false;
    try {
      if (this.base && this.base.revision !== this.current.revision) {
        if (!this.rebasePendingTextItems(this.base.text, this.current.text)) return false;
        this.updateBaseline(this.current);
      }
      if (
        current.revision !== this.currentRevision &&
        (!this.canRebase() || !this.rebasePendingTextItems(this.current.text, current.text))
      )
        return false;
      this.updateBaseline(current);
      this.applicability = EditApplicabilityState.READY;
      this.applyingItemId = null;
      synchronized = true;
      return true;
    } finally {
      if (!synchronized) this.restoreState(previous);
    }
  }

  /**
   * Makes a newly observed snapshot the reference point for all remaining work. Rebuilding `proposed` here
   * keeps its text, revision, byte order mark intent, and pending ranges tied to the same baseline.
   */
  updateBaseline(current: WorkspaceTextSnapshot): void {
    const previous = this.base ?? this.current;
    const changesByteOrderMark = previous
      ? this.proposed.byteOrderMark !== previous.byteOrderMark
      : this.proposed.byteOrderMark !== current.byteOrderMark;
    const byteOrderMark = changesByteOrderMark ? this.proposed.byteOrderMark : current.byteOrderMark;
    this.base = current;
    this.current = current;
    this.currentPath = current.path;
    this.currentRevision = current.revision;
    const proposedText = this.composePendingText(current.text);
    this.proposed = this.snapshotFor(current, proposedText, byteOrderMark);
  }

  /**
   * Builds a snapshot with the proposal's destination identity and the observed file's mode. Centralizing this
   * rule keeps predicted writes, revert previews, and revision checks byte-for-byte consistent.
   */
  snapshotFor(current: WorkspaceTextSnapshot, text: string, byteOrderMark: boolean): WorkspaceTextSnapshot {
    const bytes = Buffer.from(text, 'utf8');
    const encoded = byteOrderMark ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
    return {
      path: this.targetPath,
      text,
      byteOrderMark,
      revision: createHash('sha256').update(encoded).digest('hex'),
      byteLength: encoded.length,
      mode: current.mode,
      identity: this.proposed.identity,
    };
  }

  /**
   * Applies pending hunks from the end of the document toward the start so each replacement cannot invalidate
   * the source offsets of an earlier hunk that has yet to be composed.
   */
  private composePendingText(baseText: string): string {
    let text = baseText;
    const pending = this.items
      .filter(item => item.kind === EditReviewItemKind.TEXT && item.decision === EditDecisionState.PENDING)
      .toSorted((left, right) => right.sourceStart - left.sourceStart);
    for (const item of pending) text = FileEditPlan.applyTextItem(text, item);
    return text;
  }
}
