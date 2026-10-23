import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import type { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import type { EditOperation } from './EditOperation.ts';
import type { EditReviewItem } from '#src/editing/reviews/EditReviewItem.js';

/**
 * One file's share of an agent's edit proposal, and the live, persisted review state for that file.
 *
 * The agent proposes a change against a file as it saw it, but the human reviews it later, decides hunk by
 * hunk, and may keep editing the file in the meantime. Applying the proposal blindly would either clobber
 * those edits or apply hunks at the wrong offsets. The plan therefore keeps three views of the file: what
 * the agent saw (`base`), what it wants (`proposed`), and what is on disk now (`current`). Pending hunks can
 * then be rebased over outside edits, and the plan fails closed when that is no longer safe.
 *
 * Compiled once by `EditProposalService`, then mutated in place by `ProposalReviewManager` and checkpointed
 * after every step. Reviews and half-finished mutations survive crashes and restarts, so every field must
 * be serializable and meaningful when reloaded from disk.
 */
export interface FileEditPlan {
  /**
   * Stable key linking review items, UI previews, and model-facing receipts back to this file. Also seeds
   * the workspace operation and undo-group IDs, so a retried mutation is recognized as the same operation.
   */
  readonly id: string;
  /**
   * The agent's declared intent. It decides which workspace mutations are legal and how an automatic change
   * is reverted. Only UPDATE and RENAME can rebase pending hunks over outside edits; a CREATE or DELETE
   * whose file has changed on disk goes stale instead.
   * TODO: Ensure DELETE can be applied on a stale file
   */
  readonly operation: EditOperation;
  /**
   * The path the agent named. Kept immutable so mode policy (e.g. plan-mode edit denial) and receipts
   * always describe the agent's original request, and so reverting a rename or delete knows where to
   * restore the file.
   */
  readonly sourcePath: string;
  /**
   * Where the file should end up. Equals `sourcePath` unless renaming. Stored separately so policy checks,
   * queue-wide path collision detection, and the review UI can reason about both ends of a rename before it
   * happens.
   */
  readonly targetPath: string;
  /**
   * Present when a structural change (create, delete, rename) was applied to the workspace as soon as it
   * was staged, instead of waiting for approval. This lets the agent keep working against a real
   * filesystem layout, while the human still owes a keep-or-revert decision. Applying the change and
   * reviewing it are tracked separately, so the change is not counted as reviewed just because it is on
   * disk.
   */
  automatic?: {
    /** The structural review item that was auto-applied and still awaits the human's keep/revert decision. */
    readonly itemId: string;
    /**
     * The file as it existed before the change. Needed to recreate a deleted file on revert and to show the
     * human what the change replaced. `null` when the change created the file.
     * TODO: This might be a cause of memory bloat with many changes, might need to optimize.
     */
    readonly before: WorkspaceTextSnapshot | null;
    /**
     * Each transition is persisted before its workspace mutation. If a crash interrupts a revert, recovery
     * sees `reverting` and marks the file stale rather than guessing whether the revert landed.
     * `kept` and `reverted` are the human's final decisions.
     *
     */
    state: 'applying' | 'applied' | 'reverting' | 'reverted' | 'kept';
    /**
     * The revision this change produced. A revert proceeds only while the file still has this revision,
     * so it never discards edits made after the change landed.
     */
    appliedRevision: string | null;
  };
  /**
   * The snapshot that pending hunk offsets are relative to. `null` for CREATE. Advanced as hunks are
   * accepted or outside edits are merged, so remaining hunks stay addressable. When a rebase fails, the old
   * base is kept as evidence of what the agent intended.
   */
  base: WorkspaceTextSnapshot | null;
  /**
   * The file as it would be if every still-pending hunk were accepted on top of `base`, recomputed whenever
   * the base moves. Its revision is how crash recovery tells whether an interrupted CREATE actually landed,
   * and it carries the encoding (byte order mark, mode) the agent requested.
   */
  proposed: WorkspaceTextSnapshot;
  /**
   * The individually decidable changes, so the human can accept some hunks and reject others instead of
   * taking the agent's proposal all-or-nothing.
   */
  readonly items: EditReviewItem[];
  /**
   * The last observed on-disk snapshot, or `null` when the file is absent. Kept apart from `base` so the
   * manager can tell "the agent's assumptions" from "what is actually there". That distinction drives drift
   * detection, revert planning, and the "before" side of the review diff.
   */
  current: WorkspaceTextSnapshot | null;
  /**
   * Write-ahead intent marker, persisted before an accepted item is written to the workspace. After a
   * crash mid-write, recovery uses it to check whether the write landed. That way the change is neither
   * applied twice nor left on disk while still marked pending.
   */
  applyingItemId: string | null;
  /**
   * Reserved for parent directories created while accepting a CREATE or RENAME, so a later revert could
   * remove them. It is persisted and rolled back with the rest of the plan, but nothing currently populates
   * it. The workspace store only cleans up the directories it creates when the mutation itself fails.
   * TODO: This needs to get populated
   */
  createdDirectories: string[];
  /**
   * Whether decisions can be applied right now. `STALE` means the file changed outside the review in a way
   * that cannot be safely rebased. The human can still inspect and reject the change, but accepting it
   * would act on assumptions that no longer hold. `FAILED_RETRYABLE` means a checkpoint failed before
   * anything touched disk, so a retry is safe.
   * TODO: Stale state doesn't yet really have a recovery path for the user.
   */
  applicability: EditApplicabilityState;
  /**
   * Where the file lives right now. It differs from `sourcePath` once a rename is accepted, and from
   * `targetPath` until then. Every read and mutation targets this path, so partially reviewed renames keep
   * working.
   */
  currentPath: string;
  /**
   * The revision (SHA-256 hash of the exact bytes on disk, including any byte order mark) every workspace mutation
   * must match (optimistic concurrency), so a decision never overwrites edits the review hasn't observed. `null` means
   * the file is expected not to exist (a pending CREATE or an accepted DELETE). Reported back to the agent as the
   * resulting revision for follow-up edits.
   */
  currentRevision: string | null;
}
