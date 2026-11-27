import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { SkillPackageSourceReader } from '../../SkillPackageSource.ts';
import type { OpenSkillIndex } from '../../listSkillPackageFiles.ts';
import type { HostWorkspaceRoots } from '#src/shell/HostExecutionAuthority.js';
import type { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';

export function testPackageIndex(binaryPath: string, accessPolicy = new WorkspaceAccessPolicy()): OpenSkillIndex {
  return (root, caseSensitive, respectGitIgnore) =>
    new RustWorkspacePathIndex({
      root,
      binaryPath,
      accessPolicy,
      caseSensitive,
      maxFiles: 257,
      respectGitIgnore,
    });
}

export function testSkillSource(
  binaryPath: string,
  workspaceRoots: readonly string[],
  metadata: Pick<
    NativeFilesystemMetadata,
    'assertWorkspacePath' | 'assertHostPaths' | 'inspect' | 'sourceOrigins' | 'assertUnlinkedDirectory'
  >,
  policy: WorkspaceAccessPolicy,
  hostWorkspaceRoots: HostWorkspaceRoots = workspaceRoots,
): SkillPackageSourceReader {
  const createIndex = testPackageIndex(binaryPath, policy);
  return new SkillPackageSourceReader(
    root => {
      const store = new FileSystemWorkspaceTextStore(root, { accessPolicy: policy, physicalAccess: metadata });
      return { store, index: createIndex(root, store.caseSensitive, false) };
    },
    metadata,
    policy,
    hostWorkspaceRoots,
  );
}
