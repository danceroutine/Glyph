import { resolve, relative, isAbsolute } from 'node:path';
import { WorkspaceAccessPolicy } from '../../policy/WorkspaceAccessPolicy.ts';
import { WorkspaceRootAccess } from '../../policy/WorkspaceRootAccess.ts';
import { FileSystemWorkspaceTextStore } from '../../FileSystemWorkspaceTextStore.ts';
import { workspaceCaseSensitivity } from '../../workspaceCaseSensitivity.ts';
import type { WorkspacePathAccess } from '../../WorkspacePathAccess.ts';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import type { RustWorkspacePathIndexOptions } from '#src/context/search/RustWorkspacePathIndexOptions.js';
import { ProjectAccess } from '#src/project/ProjectAccess.js';
import type { WorkspaceTextStore } from '../../WorkspaceTextStore.ts';

interface FixtureOptions {
  caseSensitive?: boolean;
  excludedPaths?: string[];
  managedDirectories?: readonly string[] | (() => readonly string[]);
  accessPolicy?: WorkspaceAccessPolicy;
  physicalAccess?: WorkspacePathAccess;
}

export function fixtureWorkspace(root: string, options: FixtureOptions = {}) {
  const caseSensitive = options.caseSensitive ?? workspaceCaseSensitivity(root);
  const folded = (path: string) => (caseSensitive ? resolve(path) : resolve(path).toLowerCase());
  return new FileSystemWorkspaceTextStore(root, {
    access: new WorkspaceRootAccess(
      options.accessPolicy ?? new WorkspaceAccessPolicy(),
      root,
      caseSensitive,
      options.excludedPaths,
    ),
    ...(options.managedDirectories && { managedDirectories: options.managedDirectories }),
    physicalAccess: options.physicalAccess ?? {
      async assertWorkspacePath(path, privatePaths) {
        if (
          privatePaths.some(excluded => {
            const suffix = relative(folded(excluded), folded(path));
            return !suffix.startsWith('..') && !isAbsolute(suffix);
          })
        )
          throw new Error('That path is excluded from project access.');
      },
    },
  });
}

export function fixtureIndex(
  options: RustWorkspacePathIndexOptions &
    Pick<FixtureOptions, 'accessPolicy'> &
    Pick<ConstructorParameters<typeof RustWorkspacePathIndex>[0], 'readContentOverrides'>,
  processFactory?: ConstructorParameters<typeof RustWorkspacePathIndex>[1],
) {
  const {
    root,
    caseSensitive = workspaceCaseSensitivity(root),
    accessPolicy = new WorkspaceAccessPolicy(),
    excludedPaths,
    ...rest
  } = options;
  return new RustWorkspacePathIndex(
    { ...rest, access: new WorkspaceRootAccess(accessPolicy, root, caseSensitive, excludedPaths) },
    processFactory,
  );
}

export function fixtureProjectAccess(
  root: string,
  options: FixtureOptions & ConstructorParameters<typeof ProjectAccess>[2] = {},
  workspace?: WorkspaceTextStore,
  index?: ConstructorParameters<typeof ProjectAccess>[1],
  turn?: ConstructorParameters<typeof ProjectAccess>[3],
) {
  const { maxFiles, maxFileBytes, ...fixture } = options;
  const store = workspace ?? fixtureWorkspace(root, fixture);
  return new ProjectAccess(
    store,
    index ?? { glob: (pattern, query) => store.list(query.limit, pattern, query.targetDirectory, query.signal) },
    { ...(maxFiles !== undefined && { maxFiles }), ...(maxFileBytes !== undefined && { maxFileBytes }) },
    turn,
  );
}
