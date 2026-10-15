import { join } from 'node:path';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { MultiRootWorkspaceTextStore } from '#src/workspace/MultiRootWorkspaceTextStore.js';

export class OverlappingWorkspaceFixture extends MultiRootWorkspaceTextStore {
  constructor(root: string, caseSensitive = true) {
    const roots = [
      { name: 'repo', path: root },
      { name: 'pkg', path: join(root, 'pkg') },
    ];
    super(
      {
        id: 'overlapping-workspace',
        mutationIdentity: 'overlapping-roots',
        kind: ProjectContextKind.WORKSPACE,
        name: 'overlapping-workspace',
        authority: 'file',
        roots,
      },
      roots.map(({ name, path }) => ({ name, store: new FileSystemWorkspaceTextStore(path, { caseSensitive }) })),
    );
  }
}
