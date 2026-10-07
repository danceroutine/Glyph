import type { FileEditPlan } from './FileEditPlan.ts';
import type { EditProposalOrigin } from './EditProposalOrigin.ts';

export interface EditProposal {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly source: 'patch' | 'structured';
  readonly createdAt: string;
  readonly files: FileEditPlan[];
  readonly origin?: EditProposalOrigin;
  /** Delivery receipts persisted with the proposal so review feedback is exactly-once across restarts. */
  acknowledgedResultIds?: string[];
}
