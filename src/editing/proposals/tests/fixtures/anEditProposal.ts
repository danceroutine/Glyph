import type { EditProposal } from '#src/editing/proposals/EditProposal.js';

export const anEditProposal = ({ ...rest }: Partial<EditProposal>): EditProposal => ({
  schemaVersion: 1,
  id: 'proposal',
  source: 'structured',
  createdAt: new Date().toISOString(),
  files: [],
  ...rest,
});
