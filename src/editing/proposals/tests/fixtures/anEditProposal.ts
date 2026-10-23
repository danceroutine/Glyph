import { EditProposal, type EditProposalRecord } from '#src/editing/proposals/EditProposal.js';

export const anEditProposal = ({ ...rest }: Partial<EditProposalRecord>): EditProposal =>
  EditProposal.from({
    schemaVersion: 1,
    id: 'proposal',
    source: 'structured',
    createdAt: new Date().toISOString(),
    files: [],
    ...rest,
  });
