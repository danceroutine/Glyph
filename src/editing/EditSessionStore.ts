import type { EditProposal } from './EditProposal.ts';

export interface EditSessionStore {
  load(): Promise<EditProposal | undefined>;
  save(proposal: EditProposal): Promise<void>;
  clear(): Promise<void>;
}
