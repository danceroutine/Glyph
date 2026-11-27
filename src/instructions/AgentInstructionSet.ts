import { defaultInstructionPaths } from './InstructionPaths.ts';
import {
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
  type AgentInstructionSource,
} from './AgentInstructionSource.ts';

/**
 * A composed collection of discovered instructions, ordered from broad to specific.
 * Owns compatibility shadowing, source precedence, and ancestor selection without
 * performing discovery or tracking whether a source has been activated in a turn.
 */
export class AgentInstructionSet {
  private static readonly SOURCE_PRIORITY: Readonly<Record<AgentInstructionSourceKind, number>> = {
    [AgentInstructionSourceKind.GLYPH_USER_RULE]: 0,
    [AgentInstructionSourceKind.CURSOR_PROJECT_RULE]: 1,
    [AgentInstructionSourceKind.GLYPH_PROJECT_RULE]: 2,
    [AgentInstructionSourceKind.AGENTS_MD]: 3,
  };

  /** Effective sources in precedence order, including disabled sources and discovery errors. */
  readonly sources: readonly AgentInstructionSource[];
  readonly rootGuidance: readonly AgentInstructionSource[];
  private readonly order = new Map<AgentInstructionSource, number>();
  private readonly activeByScope = new Map<string, AgentInstructionSource[]>();

  /** Native project rules shadow same-name Cursor rules only within the same scope. */
  constructor(
    sources: readonly AgentInstructionSource[],
    private readonly paths = defaultInstructionPaths,
  ) {
    const native = new Set(
      sources
        .filter(source => source.kind === AgentInstructionSourceKind.GLYPH_PROJECT_RULE)
        .map(source => compatibilityKey(source, paths.key(source.scope))),
    );
    const depth = new Map(
      [...new Set(sources.map(source => source.scope))].map(scope => [
        scope,
        Math.max(...paths.equivalents(scope).map(route => scopeDepth(route))),
      ]),
    );
    this.sources = sources
      .filter(
        source =>
          source.kind !== AgentInstructionSourceKind.CURSOR_PROJECT_RULE ||
          !native.has(compatibilityKey(source, paths.key(source.scope))),
      )
      .toSorted(
        (left, right) =>
          depth.get(left.scope)! - depth.get(right.scope)! ||
          AgentInstructionSet.SOURCE_PRIORITY[left.kind] - AgentInstructionSet.SOURCE_PRIORITY[right.kind] ||
          left.path.localeCompare(right.path),
      );
    this.rootGuidance = this.sources.filter(
      source =>
        source.status === AgentInstructionSourceStatus.ACTIVE &&
        source.kind === AgentInstructionSourceKind.AGENTS_MD &&
        paths.isWorkspaceRoot(source.scope),
    );
    for (const [index, source] of this.sources.entries()) {
      this.order.set(source, index);
      if (source.status !== AgentInstructionSourceStatus.ACTIVE) continue;
      const scope = paths.key(source.scope);
      const bucket = this.activeByScope.get(scope);
      if (bucket) bucket.push(source);
      else this.activeByScope.set(scope, [source]);
    }
  }

  /**
   * Select successfully read ancestors of a workspace-relative target.
   * This is scope resolution only; enablement, glob matching, and disclosure belong
   * to the turn context session. Later sources have higher precedence.
   * Visits the ancestor buckets for each equivalent workspace route and orders the matched sources. The returned array does not expose the stored buckets.
   */
  forPath(path: string): readonly AgentInstructionSource[] {
    const result = new Set(this.activeByScope.get('.'));
    for (const route of this.paths.equivalents(path)) {
      let scope = '';
      for (const segment of this.paths.key(route).split('/')) {
        scope = scope ? `${scope}/${segment}` : segment;
        if (scope === '.') continue;
        const bucket = this.activeByScope.get(scope);
        if (bucket) for (const source of bucket) result.add(source);
      }
    }
    return [...result].toSorted((left, right) => this.order.get(left)! - this.order.get(right)!);
  }
}

function compatibilityKey(source: AgentInstructionSource, scope: string): string {
  return `${scope}\0${source.name ?? source.path}`;
}

function scopeDepth(scope: string): number {
  return scope === '.' ? 0 : scope.split('/').length;
}
