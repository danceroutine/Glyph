import type { WorkspaceTextSnapshot } from '#src/workspace/WorkspaceTextSnapshot.ts';

export const aWorkspaceTextSnapshot = ({ ...rest }: Partial<WorkspaceTextSnapshot>): WorkspaceTextSnapshot => ({
  path: 'path',
  text: 'text',
  byteOrderMark: false,
  revision: 'revision',
  byteLength: 0,
  mode: 0o644,
  identity: 'identity',
  ...rest,
});
