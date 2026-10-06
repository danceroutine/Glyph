import type { WorkspaceTextSnapshot } from '../../workspace/WorkspaceTextSnapshot.ts';
import type { EditApplicabilityState } from '../reviews/EditApplicabilityState.ts';
import type { EditOperation } from './EditOperation.ts';
import type { EditReviewItem } from '../reviews/EditReviewItem.ts';

export interface FileEditPlan {
  readonly id: string;
  readonly operation: EditOperation;
  readonly sourcePath: string;
  readonly targetPath: string;
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
