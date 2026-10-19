import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.js';
import type { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.js';
import type { EditOperation } from './EditOperation.ts';
import type { EditReviewItem } from '#src/editing/reviews/EditReviewItem.js';

export interface FileEditPlan {
  readonly id: string;
  readonly operation: EditOperation;
  readonly sourcePath: string;
  readonly targetPath: string;
  automatic?: {
    readonly itemId: string;
    readonly before: WorkspaceTextSnapshot | null;
    state: 'applying' | 'applied' | 'reverting' | 'reverted' | 'kept';
    appliedRevision: string | null;
  };
  base: WorkspaceTextSnapshot | null;
  proposed: WorkspaceTextSnapshot;
  readonly items: EditReviewItem[];
  current: WorkspaceTextSnapshot | null;
  applyingItemId: string | null;
  createdDirectories: string[];
  applicability: EditApplicabilityState;
  currentPath: string;
  currentRevision: string | null;
}
