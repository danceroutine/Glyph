import { trustedHostExecutable, type HostExecutable } from '#src/shell/TrustedHostExecutable.js';
import { chmod, mkdir, mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import type { SkillPackage } from './SkillPackage.ts';

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
    private readonly shells: Pick<ShellSessionManager, 'execute'>,
    private readonly roots: readonly SkillExecutionRoot[],
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
    await chmod(directory, 0o700);
    try {
      for (const [file, content] of files) {
        signal.throwIfAborted();
        if (file.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/u.test(file))
          throw new Error('Pinned package contains an invalid resource path.');
        const destination = join(directory, file);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, content.bytes, { flag: 'wx', mode: content.mode & 0o111 ? 0o500 : 0o400 });
      }
      const command = `# Skill ${skill.descriptor.name}, revision ${skill.revision}\n# Interpreter: ${executable}\n# Compatibility: ${(skill.descriptor.compatibility ?? 'No requirements declared').replaceAll('\n', '\n# ')}\n${source
        .split('\n')
        .map(line => `# ${line}`)
        .join(
          '\n',
        )}\n${quote(executable)} ${quote(join(directory, path))} ${args.map(argument => quote(argument)).join(' ')}`;
      const result = await this.shells.execute(command, {
        ownerChatId,
        signal,
        timeoutMs: 600000,
        background: false,
        workingDirectory: root.workingDirectory,
        transient: true,
        readOnlyPaths: [directory],
      });
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
      await rm(directory, { recursive: true, force: true });
    }
  }
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
