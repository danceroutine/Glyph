import { basename, dirname, join, posix, relative, sep } from 'node:path';
import { AgentInstructionSourceKind } from '../AgentInstructionSource.ts';
import type { InstructionPaths } from '../InstructionPaths.ts';

/** The profile owns rules even when a workspace also exposes the same native or compatibility directory. */
export class UserRuleDirectory {
  private readonly rules: string;
  private readonly project?: { kind: AgentInstructionSourceKind; directory: string; scope: string };

  constructor(
    root: string,
    private readonly caseSensitive: boolean,
    roots: readonly { name: string; path: string }[],
    private readonly paths: InstructionPaths,
  ) {
    this.rules = this.key(join(root, 'rules'));
    const marker = this.key(basename(root));
    if (marker !== '.glyph' && marker !== '.cursor') return;
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
    return physical !== undefined && this.key(dirname(physical)) === this.rules;
  }

  projectAlias(userPath: string) {
    if (!this.project || !userPath.startsWith('rules/')) return undefined;
    const { kind, directory, scope } = this.project;
    const identity = this.paths.sourceIdentity(kind, posix.join(directory, userPath));
    return { ...identity, scope, kind };
  }

  private key(path: string): string {
    return this.caseSensitive ? path : path.toLowerCase();
  }
}
