import { authorizeSources } from '#src/workspace/SourceDisclosure.js';
import { resolveAvailableIdentity } from '#src/shell/ShellRuntimePathPolicy.js';
import { escapeDisplayControls } from '#src/shared/presentation/escapeDisplayControls.js';
import type { HostExecutable } from '#src/shell/TrustedHostExecutable.js';
import { HostExecutionAuthority, type HostWorkspaceRoots } from '#src/shell/HostExecutionAuthority.js';
import type { HostFilesystemAuthority } from '#src/workspace/HostFilesystemAuthority.js';
import { ShellProgram } from '#src/shell/ShellProgram.js';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, realpath, open, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import type { SkillPackage } from './SkillPackage.ts';
import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import { skillExecutionDirectory } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import type { WorkspaceDirectoryMutations } from '#src/workspace/WorkspaceDirectoryMutations.js';
import { inspectPrivateDirectory } from '#src/workspace/privateStorageMetadata.js';

/** A host-authorized project root and the discovery origins whose scripts it owns. */
export interface SkillExecutionRoot {
  readonly id: string;
  readonly label: string;
  readonly directory: string;
  readonly workingDirectory: string;
  readonly originIds: readonly string[];
}

/**
 * Executes a captured package through one-shot shell approval. The interpreter
 * may load any staged resource. Check that every source remains authorized
 * before staging, when showing the command for approval, and at launch. The
 * staging directory and executable must also remain outside attached roots.
 */
export class SkillScriptRunner {
  constructor(
    private readonly shells: Pick<ShellSessionManager, 'executeProgram'>,
    private readonly roots: readonly SkillExecutionRoot[],
    private readonly metadata: FilesystemMetadata & HostFilesystemAuthority,
    private readonly openCleanup: (root: string) => Promise<Pick<WorkspaceDirectoryMutations, 'removeTree'>>,
    private readonly stagingRoot = tmpdir(),
    private readonly hostWorkspaceRoots: HostWorkspaceRoots = roots.map(root => root.directory),
  ) {}

  /** Public target metadata contains logical identifiers rather than filesystem locations. */
  get targets(): readonly { id: string; label: string }[] {
    return this.roots.map(({ id, label }) => ({ id, label }));
  }

  async run(
    skill: SkillPackage,
    path: string,
    args: readonly string[],
    ownerChatId: string,
    signal: AbortSignal,
    workspaceRootId?: string,
    assertActive?: () => void,
  ) {
    signal.throwIfAborted();
    if (!path.startsWith('scripts/')) throw new Error('Executable skill resources must be in scripts/.');
    if (
      skill.descriptor.allowedTools.length > 0 &&
      !skill.descriptor.allowedTools.some(tool => ['shell', 'shell.execute_shell', 'Bash'].includes(tool))
    )
      throw new Error('This skill does not declare permission to use the shell execution tool.');
    // Inspection does not claim that the model has read the resource.
    const files = skill.packageFiles();
    const pins = skill.disclosurePins([...files.keys()]);
    const authorizePackage = async () => {
      const checkSources = await authorizeSources(pins, signal);
      const assertCurrent = () => {
        checkSources();
        assertActive?.();
      };
      assertCurrent();
      return assertCurrent;
    };
    const checkStaging = await authorizePackage();
    const resource = skill.inspectResource(path);
    if (resource.encoding !== 'utf8') throw new Error('Skill scripts must contain UTF-8 source.');
    const source = escapeDisplayControls(resource.content);
    const interpreter = (
      { '.sh': 'sh', '.py': 'python3', '.js': 'node', '.mjs': 'node' } as Readonly<Record<string, HostExecutable>>
    )[extname(path)];
    if (!interpreter) throw new Error('Supported skill interpreters are sh, python3, and node.');
    const owner =
      skill.descriptor.origin.scope === 'project'
        ? this.roots.find(root => root.originIds.includes(skill.descriptor.origin.id))
        : undefined;
    const root = workspaceRootId
      ? this.roots.find(candidate => candidate.id === workspaceRootId)
      : (owner ?? (this.roots.length === 1 ? this.roots[0] : undefined));
    if (!root || (skill.descriptor.origin.scope === 'project' && owner !== root))
      throw new Error(
        'Select the owning workspace_root_id; user skills require an explicit root in multi-root workspaces.',
      );

    await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 });
    const stagingRoot = await realpath(this.stagingRoot);
    for (const candidate of this.roots) {
      const directory =
        candidate === root ? await realpath(root.directory) : resolveAvailableIdentity(candidate.directory);
      const from = relative(directory, stagingRoot);
      if (from === '' || (!isAbsolute(from) && from !== '..' && !from.startsWith(`..${sep}`)))
        throw new Error('Skill execution staging must be outside every workspace root.');
    }
    const authority = new HostExecutionAuthority(this.hostWorkspaceRoots, this.metadata);
    authority.admit(stagingRoot);
    const executable = authority.executable(interpreter);
    await authority.validate();
    const cleanup = await this.openCleanup(stagingRoot);
    const allocation = await mkdtemp(join(stagingRoot, 'glyph-skill-run-'));
    const directory = join(allocation, skillExecutionDirectory);
    const unreadableDirectories: FileHandle[] = [];
    try {
      authority.admit(allocation);
      await authority.validate();
      await inspectPrivateDirectory(this.metadata, allocation);
      await mkdir(directory, { mode: 0o700 });
      await inspectPrivateDirectory(this.metadata, directory);
      const stagePath = (entry: string) => {
        signal.throwIfAborted();
        if (entry.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/u.test(entry))
          throw new Error('Pinned package contains an invalid resource path.');
        return join(directory, entry);
      };
      for (const folder of skill.packageDirectories().keys()) {
        await mkdir(stagePath(folder), { recursive: true, mode: 0o700 });
      }
      for (const [file, content] of files) {
        const destination = stagePath(file);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const handle = await open(destination, 'wx', 0o600);
        try {
          await this.metadata.inspect(handle, 'access');
          checkStaging();
          await handle.writeFile(content.bytes);
          await handle.chmod(content.mode);
        } finally {
          await handle.close();
        }
      }
      // Populate through private, writable ancestors, then retain the reviewed directory modes.
      for (const [folder, mode] of [...skill.packageDirectories()].toSorted(
        (a, b) => b[0].split('/').length - a[0].split('/').length,
      )) {
        const handle = await open(stagePath(folder), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if ((mode & 0o400) === 0) {
          // Hold the original directory while its reviewed mode prevents a cleanup walker from opening it.
          unreadableDirectories.push(handle);
          await handle.chmod(mode);
        } else {
          try {
            await handle.chmod(mode);
          } finally {
            await handle.close();
          }
        }
      }
      const description = `# Skill ${skill.descriptor.name}, revision ${skill.revision}\n# Interpreter: ${executable}\n# Compatibility: ${(skill.descriptor.compatibility ?? 'No requirements declared').replaceAll('\n', '\n# ')}\n${source
        .split('\n')
        .map(line => `# ${line}`)
        .join('\n')}`;
      const authorizeProgram = async () => {
        const checkPackage = await authorizePackage();
        const checkHost = await authority.validate();
        return () => {
          checkHost();
          checkPackage();
        };
      };
      const result = await this.shells.executeProgram(
        new ShellProgram(executable, [join(directory, path), ...args], description, authorizeProgram),
        {
          ownerChatId,
          signal,
          timeoutMs: 600000,
          background: false,
          workingDirectory: root.workingDirectory,
          transient: true,
          readOnlyPaths: [directory],
        },
      );
      // Keep the outcome before potentially truncated process output in model transcripts.
      return {
        exitCode: result.exitCode,
        skillId: skill.descriptor.id,
        packageRevision: skill.revision,
        script: path,
        workflowCompleted: false,
        compatibility: skill.descriptor.compatibility ?? '',
        ...result,
      };
    } finally {
      try {
        await Promise.all(
          unreadableDirectories.map(async handle => {
            try {
              await handle.chmod(0o700);
            } finally {
              await handle.close();
            }
          }),
        );
      } finally {
        await cleanup.removeTree(basename(allocation));
      }
    }
  }
}
