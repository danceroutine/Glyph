import { WorkspaceRootAccess } from '#src/workspace/policy/WorkspaceRootAccess.js';
import { workspaceCaseSensitivity } from '#src/workspace/workspaceCaseSensitivity.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { SkillPackageSourceReader } from '#src/skills/SkillPackageSource.js';
import type { OpenSkillIndex } from '#src/skills/listSkillPackageFiles.js';
import { HostProcessLeases, type HostWorkspaceRoots } from '#src/shell/HostProcessLeases.js';
import type { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';

export function testPackageIndex(binaryPath: string, accessPolicy = new WorkspaceAccessPolicy()): OpenSkillIndex {
  return (root, caseSensitive, respectGitIgnore) =>
    new RustWorkspacePathIndex({
      access: new WorkspaceRootAccess(accessPolicy, root, caseSensitive),
      binaryPath,
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
  workspace: HostWorkspaceRoots | HostProcessLeases = workspaceRoots,
): SkillPackageSourceReader {
  return new SkillPackageSourceReader(
    root => {
      const access = new WorkspaceRootAccess(policy, root, workspaceCaseSensitivity(root));
      const store = new FileSystemWorkspaceTextStore(root, { access, physicalAccess: metadata });
      return {
        store,
        index: new RustWorkspacePathIndex({ binaryPath, access, maxFiles: 257, respectGitIgnore: false }),
      };
    },
    metadata,
    policy,
    workspace instanceof HostProcessLeases ? workspace : new HostProcessLeases(workspace),
  );
}
