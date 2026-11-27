import { sameWorkspaceDirectory, WorkspaceDirectoryIdentity } from '#src/workspace/sameWorkspaceDirectory.js';
import { dirname, join, posix, relative, sep } from 'node:path';
import { AgentInstructionSourceKind } from '#src/instructions/AgentInstructionSource.js';
import type { InstructionPaths } from '#src/instructions/InstructionPaths.js';

/** The profile owns rules even when a workspace also exposes the same native or compatibility directory. */
export class UserRuleDirectory {
  private readonly rules: WorkspaceDirectoryIdentity;
  private readonly project?: { kind: AgentInstructionSourceKind; directory: string; scope: string };

  constructor(
    root: string,
    private readonly caseSensitive: boolean,
    roots: readonly { name: string; path: string }[],
    private readonly paths: InstructionPaths,
  ) {
    this.rules = new WorkspaceDirectoryIdentity(join(root, 'rules'), caseSensitive);
    const marker = ['.glyph', '.cursor'].find(name =>
      sameWorkspaceDirectory(root, join(dirname(root), name), this.caseSensitive),
    );
    if (!marker) return;
    // A workspace opened inside the marker cannot discover it as a project rule directory.
    for (const part of roots.toSorted((a, b) => b.path.length - a.path.length)) {
      const suffix = relative(part.path, root);
      if (!suffix || suffix === '..' || suffix.startsWith('..' + sep)) continue;
      const directory = posix.join(roots.length > 1 ? part.name : '', suffix.split(sep).join('/'));
      this.project = {
        kind:
          marker === '.glyph'
            ? AgentInstructionSourceKind.GLYPH_PROJECT_RULE
            : AgentInstructionSourceKind.CURSOR_PROJECT_RULE,
        directory,
        scope: posix.dirname(directory),
      };
      break;
    }
  }

  ownsProjectRule(path: string): boolean {
    const physical = this.paths.routes!.physicalPath(path);
    return physical !== undefined && this.rules.matches(dirname(physical));
  }

  projectAlias(userPath: string) {
    if (!this.project || !userPath.startsWith('rules/')) return undefined;
    const { kind, directory, scope } = this.project;
    const identity = this.paths.sourceIdentity(kind, posix.join(directory, userPath));
    return { ...identity, scope, kind };
  }
}
