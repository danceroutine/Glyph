import type { WorkspaceTextSnapshot } from '../workspace/WorkspaceTextSnapshot.ts';
import type { EditApplicabilityState } from './EditApplicabilityState.ts';
import type { EditOperation } from './EditOperation.ts';
import type { EditReviewItem } from './EditReviewItem.ts';

export interface FileEditPlan {
  readonly id: string;
  readonly operation: EditOperation;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly base: WorkspaceTextSnapshot | null;
  readonly proposed: WorkspaceTextSnapshot;
  readonly items: EditReviewItem[];
  current: WorkspaceTextSnapshot | null;
  applyingItemId: string | null;
  createdDirectories: string[];
  applicability: EditApplicabilityState;
  currentPath: string;
  currentRevision: string | null;
}
