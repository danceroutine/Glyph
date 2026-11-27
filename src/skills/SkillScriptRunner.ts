import { trustedHostExecutable, type HostExecutable } from '#src/shell/TrustedHostExecutable.js';
import { ShellProgram } from '#src/shell/ShellProgram.js';
import { chmod, mkdir, mkdtemp, realpath, open, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import type { SkillPackage } from './SkillPackage.ts';
import type { FilesystemMetadata } from '#src/workspace/FilesystemMetadata.js';
import { inspectPrivateDirectory } from '#src/workspace/privateStorageMetadata.js';

/** A host-authorized project root and the discovery origins whose scripts it owns. */
export interface SkillExecutionRoot {
  readonly id: string;
  readonly label: string;
  readonly directory: string;
  readonly workingDirectory: string;
  readonly originIds: readonly string[];
}

/** Executes pinned resources outside writable workspaces, with one-shot shell approval. */
export class SkillScriptRunner {
  constructor(
    private readonly shells: Pick<ShellSessionManager, 'executeProgram'>,
    private readonly roots: readonly SkillExecutionRoot[],
    private readonly metadata: FilesystemMetadata,
    private readonly stagingRoot = tmpdir(),
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
    const resource = skill.inspectResource(path);
    if (resource.encoding !== 'utf8') throw new Error('Skill scripts must contain UTF-8 source.');
    const source = resource.content;
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
      const directory = await realpath(candidate.directory);
      const from = relative(directory, stagingRoot);
      if (from === '' || (!isAbsolute(from) && from !== '..' && !from.startsWith(`..${sep}`)))
        throw new Error('Skill execution staging must be outside every workspace root.');
    }
    const executable = trustedHostExecutable(
      interpreter,
      this.roots.map(candidate => candidate.directory),
    );
    const directory = await mkdtemp(join(stagingRoot, 'glyph-skill-run-'));
    const stagedDirectories: string[] = [];
    try {
      await chmod(directory, 0o700);
      await inspectPrivateDirectory(this.metadata, directory);
      const stagePath = (entry: string) => {
        signal.throwIfAborted();
        if (entry.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/u.test(entry))
          throw new Error('Pinned package contains an invalid resource path.');
        return join(directory, entry);
      };
      for (const folder of skill.packageDirectories().keys()) {
        await mkdir(stagePath(folder), { recursive: true, mode: 0o700 });
        stagedDirectories.push(folder);
      }
      for (const [file, content] of files) {
        const destination = stagePath(file);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        const handle = await open(destination, 'wx', 0o600);
        try {
          await this.metadata.inspect(handle, 'access');
          await handle.writeFile(content.bytes);
          await handle.chmod(content.mode);
        } finally {
          await handle.close();
        }
      }
      // Populate through private, writable ancestors, then retain the reviewed directory modes.
      for (const [folder, mode] of [...skill.packageDirectories()].sort(
        (a, b) => b[0].split('/').length - a[0].split('/').length,
      ))
        await chmod(stagePath(folder), mode);
      const description = `# Skill ${skill.descriptor.name}, revision ${skill.revision}\n# Interpreter: ${executable}\n# Compatibility: ${(skill.descriptor.compatibility ?? 'No requirements declared').replaceAll('\n', '\n# ')}\n${source
        .split('\n')
        .map(line => `# ${line}`)
        .join('\n')}`;
      const result = await this.shells.executeProgram(
        new ShellProgram(executable, [join(directory, path), ...args], description),
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
      // Restore traversal from the private root before removing a reviewed read-only scaffold.
      for (const folder of stagedDirectories.sort((a, b) => a.split('/').length - b.split('/').length))
        await chmod(join(directory, folder), 0o700).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }
}
