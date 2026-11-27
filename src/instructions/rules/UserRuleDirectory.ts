import { UserStoreProjectRoutes } from '#src/workspace/UserStoreProjectRoutes.js';
import type { SourcePathAliases } from '#src/workspace/SourcePathAliases.js';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { AgentInstructionSourceKind } from '#src/instructions/AgentInstructionSource.js';
import type { InstructionPaths } from '#src/instructions/InstructionPaths.js';

/** The profile owns rules even when a workspace also exposes the same native or compatibility directory. */
export class UserRuleDirectory {
  private readonly store: UserStoreProjectRoutes;

  constructor(
    root: string,
    caseSensitive: boolean,
    private readonly roots: readonly { name: string; path: string }[],
    private readonly paths: InstructionPaths,
    aliases?: SourcePathAliases,
  ) {
    this.store = new UserStoreProjectRoutes(join(root, 'rules'), caseSensitive, aliases);
  }

  refresh(): void {
    this.store.refresh();
  }

  ownsProjectRule(path: string): boolean {
    const physical = this.paths.routes!.physicalPath(path);
    return physical !== undefined && this.store.ownsEntry(physical);
  }

  projectAlias(userPath: string) {
    if (!userPath.startsWith('rules/')) return undefined;
    const aliases = this.store.projectEntries(basename(userPath)).flatMap(path => {
      const marker = this.store.projectMarker(path);
      if (!marker) return [];
      const kind =
        marker === '.glyph'
          ? AgentInstructionSourceKind.GLYPH_PROJECT_RULE
          : AgentInstructionSourceKind.CURSOR_PROJECT_RULE;
      const scope = dirname(dirname(dirname(path)));
      const project = this.roots
        .toSorted((a, b) => b.path.length - a.path.length)
        .find(part => {
          const tail = relative(part.path, scope);
          return tail !== '..' && !tail.startsWith('..' + sep) && !isAbsolute(tail);
        });
      if (!project) return [];
      const prefix = this.roots.length > 1 ? project.name : '';
      const route = (physical: string) => posix.join(prefix, relative(project.path, physical).split(sep).join('/'));
      return [{ ...this.paths.sourceIdentity(kind, route(path)), kind, scope: route(scope) }];
    });
    const [first, ...others] = aliases;
    if (!first || !others.length) return first;
    return {
      ...first,
      additionalScopes: others.map(({ kind, scope }) => ({ kind, scope })),
      legacyIds: [
        ...new Set([...(first.legacyIds ?? []), ...others.flatMap(alias => [alias.id, ...(alias.legacyIds ?? [])])]),
      ],
    };
  }
}
