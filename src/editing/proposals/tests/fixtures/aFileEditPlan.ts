import { EditApplicabilityState } from '#src/editing/reviews/EditApplicabilityState.ts';
import { EditOperation } from '#src/editing/proposals/EditOperation.ts';
import { FileEditPlan, type FileEditPlanRecord } from '#src/editing/proposals/FileEditPlan.ts';
import { aWorkspaceTextSnapshot } from '#src/workspace/tests/fixtures/aWorkspaceTextSnapshot.ts';

export const aFileEditPlan = ({ ...rest }: Partial<FileEditPlanRecord>): FileEditPlan =>
  FileEditPlan.from({
    id: 'file',
    operation: EditOperation.CREATE,
    sourcePath: 'source.txt',
    targetPath: 'target.txt',
    base: null,
    proposed: aWorkspaceTextSnapshot({}),
    items: [],
    current: null,
    applyingItemId: null,
    createdDirectories: [],
    applicability: EditApplicabilityState.READY,
    currentPath: 'current.txt',
    currentRevision: null,
    ...rest,
  });
