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
  private readonly activeByScope = new Map<string, AgentInstructionSource[]>();

  /** Native project rules shadow same-name Cursor rules only within the same scope. */
  constructor(sources: readonly AgentInstructionSource[]) {
    const native = new Set(
      sources
        .filter(source => source.kind === AgentInstructionSourceKind.GLYPH_PROJECT_RULE)
        .map(source => compatibilityKey(source)),
    );
    this.sources = sources
      .filter(
        source =>
          source.kind !== AgentInstructionSourceKind.CURSOR_PROJECT_RULE || !native.has(compatibilityKey(source)),
      )
      .toSorted(
        (left, right) =>
          scopeDepth(left.scope) - scopeDepth(right.scope) ||
          AgentInstructionSet.SOURCE_PRIORITY[left.kind] - AgentInstructionSet.SOURCE_PRIORITY[right.kind] ||
          left.path.localeCompare(right.path),
      );
    for (const source of this.sources) {
      if (source.status !== AgentInstructionSourceStatus.ACTIVE) continue;
      const bucket = this.activeByScope.get(source.scope);
      if (bucket) bucket.push(source);
      else this.activeByScope.set(source.scope, [source]);
    }
  }

  /**
   * Select successfully read ancestors of a workspace-relative target.
   * This is scope resolution only; enablement, glob matching, and disclosure belong
   * to the turn context session. Later sources have higher precedence.
   * Visits only ancestor scope buckets, with O(depth + matches) lookup work instead
   * of scanning the catalog. The returned array does not expose the stored buckets.
   */
  forPath(path: string): readonly AgentInstructionSource[] {
    const result = [...(this.activeByScope.get('.') ?? [])];
    let scope = '';
    for (const segment of path.split('/')) {
      scope = scope ? `${scope}/${segment}` : segment;
      if (scope === '.') continue;
      const bucket = this.activeByScope.get(scope);
      if (bucket) for (const source of bucket) result.push(source);
    }
    return result;
  }
}

function compatibilityKey(source: AgentInstructionSource): string {
  return `${source.scope}\0${source.name ?? source.path}`;
}

function scopeDepth(scope: string): number {
  return scope === '.' ? 0 : scope.split('/').length;
}
