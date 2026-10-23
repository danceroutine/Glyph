import type { FileEditPlanRecord } from '#src/editing/proposals/FileEditPlan.js';
import { EditDecisionState } from './EditDecisionState.ts';
import type { EditReviewItem } from './EditReviewItem.ts';

/** Application and human review are separate decisions. */
export function isReviewItemPending(file: FileEditPlanRecord, item: EditReviewItem): boolean {
  const automatic = item.appliedText ?? (file.automatic?.itemId === item.id ? file.automatic : undefined);
  return automatic ? !['kept', 'reverted'].includes(automatic.state) : item.decision === EditDecisionState.PENDING;
}
