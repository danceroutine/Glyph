import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import type { ShellSessionManager } from '#src/shell/ShellSessionManager.js';
import type { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import type { SkillPackage } from './SkillPackage.ts';

/** Executes pinned scripts through the owning chat's ordinary shell grants, sandbox, cancellation, and output handling. */
export class SkillScriptRunner {
  constructor(
    private readonly shells: Pick<ShellSessionManager, 'execute'>,
    private readonly workspace: FileSystemWorkspaceTextStore,
    private readonly rootPrefix?: string,
  ) {}
  async run(skill: SkillPackage, path: string, args: readonly string[], ownerChatId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!path.startsWith('scripts/')) throw new Error('Executable skill resources must be in scripts/.');
    if (
      skill.descriptor.allowedTools.length > 0 &&
      !skill.descriptor.allowedTools.some(tool => ['shell', 'shell.execute_shell', 'Bash'].includes(tool))
    )
      throw new Error('This skill does not declare permission to use the shell execution tool.');
    const resource = skill.readResource(path);
    if (resource.encoding !== 'utf8') throw new Error('Skill scripts must contain UTF-8 source.');
    const interpreter = (
      { '.sh': 'sh', '.py': 'python3', '.js': 'node', '.mjs': 'node' } as Readonly<Record<string, string>>
    )[extname(path)];
    if (!interpreter) throw new Error('Supported skill interpreters are sh, python3, and node.');
    const relative = `.glyph/.skill-runs/${randomUUID()}`;
    const directory = await this.workspace.canonicalPath(relative);
    await mkdir(directory, { recursive: true });
    try {
      for (const [file, content] of skill.packageFiles()) {
        signal.throwIfAborted();
        if (file.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/u.test(file))
          throw new Error('Pinned package contains an invalid resource path.');
        const destination = join(directory, file);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content.bytes, { flag: 'wx', mode: 0o400 });
      }
      const command = `# Skill ${skill.descriptor.name}, revision ${skill.revision}\n# Compatibility: ${(skill.descriptor.compatibility ?? 'No requirements declared').replaceAll('\n', '\n# ')}\n${resource.content
        .split('\n')
        .map(line => `# ${line}`)
        .join(
          '\n',
        )}\n${interpreter} ${quote(join(directory, path))} ${args.map(argument => quote(argument)).join(' ')}`;
      const result = await this.shells.execute(command, {
        ownerChatId,
        signal,
        timeoutMs: 600000,
        background: false,
        workingDirectory: this.rootPrefix ?? '.',
      });
      return {
        ...result,
        skillId: skill.descriptor.id,
        packageRevision: skill.revision,
        script: path,
        compatibility: skill.descriptor.compatibility ?? '',
        workflowCompleted: false,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
