import type { FileEditPlan } from './FileEditPlan.ts';

export interface EditProposal {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly source: 'patch' | 'structured';
  readonly createdAt: string;
  readonly files: FileEditPlan[];
}
