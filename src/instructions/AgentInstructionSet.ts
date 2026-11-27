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
  private readonly byScope = new Map<string, AgentInstructionSource[]>();

  /** Native project rules shadow same-name Cursor rules only within the same scope. */
  constructor(
    sources: readonly AgentInstructionSource[],
    private readonly paths = defaultInstructionPaths,
  ) {
    paths.prepare(
      sources.flatMap(({ scope, projectAlias }) =>
        projectAlias
          ? [scope, projectAlias.scope, ...(projectAlias.additionalScopes ?? []).map(location => location.scope)]
          : [scope],
      ),
    );
    const scopes = new Map<string, string>();
    const scopeKey = (scope: string) => {
      let key = scopes.get(scope);
      if (key === undefined) {
        key = paths.routes?.physicalScopeKey(scope) ?? paths.key(paths.equivalents(scope)[0]!);
        scopes.set(scope, key);
      }
      return key;
    };
    const native = new Set(
      sources
        .filter(source => source.kind === AgentInstructionSourceKind.GLYPH_PROJECT_RULE)
        .map(source => compatibilityKey(source, scopeKey(source.scope))),
    );
    for (const source of sources) {
      const alias = source.projectAlias;
      if (alias)
        for (const location of [alias, ...(alias.additionalScopes ?? [])]) {
          if (location.kind === AgentInstructionSourceKind.GLYPH_PROJECT_RULE)
            native.add(compatibilityKey(source, scopeKey(location.scope)));
        }
    }
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
          !native.has(compatibilityKey(source, scopeKey(source.scope))),
      )
      .map(source => {
        if (!source.projectAlias) return source;
        const { projectAlias, ...owner } = source;
        return { ...owner, legacyIds: [projectAlias.id, ...(projectAlias.legacyIds ?? [])] };
      })
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
      if (source.status !== AgentInstructionSourceStatus.ACTIVE && !isUnavailableGuidance(source)) continue;
      const scope = paths.key(source.scope);
      const bucket = this.byScope.get(scope);
      if (bucket) bucket.push(source);
      else this.byScope.set(scope, [source]);
    }
  }

  /**
   * Select successfully read ancestors of a workspace-relative target.
   * This is scope resolution only; enablement, glob matching, and disclosure belong
   * to the turn context session. Later sources have higher precedence.
   * Visits the ancestor buckets for each equivalent workspace route and orders the matched sources. The returned array does not expose the stored buckets.
   */
  forPath(path: string, includeUnavailableGuidance = false): readonly AgentInstructionSource[] {
    return this.forPaths([path], includeUnavailableGuidance);
  }

  forPaths(paths: readonly string[], includeUnavailableGuidance: boolean): readonly AgentInstructionSource[] {
    this.paths.prepare(paths);
    return this.forScopes(
      new Set(paths.flatMap(path => [...this.paths.ancestorKeys(path)])),
      includeUnavailableGuidance,
    );
  }

  /** Resolve the scope buckets already visited by this disclosure batch. */
  forScopes(keys: Iterable<string>, includeUnavailableGuidance: boolean): readonly AgentInstructionSource[] {
    const result = new Set(this.byScope.get('.'));
    for (const key of keys) {
      const bucket = this.byScope.get(key);
      if (bucket) for (const source of bucket) result.add(source);
    }
    const ordered = [...result].toSorted((left, right) => this.order.get(left)! - this.order.get(right)!);
    return includeUnavailableGuidance
      ? ordered
      : ordered.filter(source => source.status === AgentInstructionSourceStatus.ACTIVE);
  }
}

/** A catalog count diagnostic describes partial nested discovery. A failed source or lookup carries mandatory scope. */
export function isUnavailableGuidance(source: AgentInstructionSource): boolean {
  return (
    source.kind === AgentInstructionSourceKind.AGENTS_MD &&
    source.status === AgentInstructionSourceStatus.ERROR &&
    source.id !== 'agents_md:discovery-limit'
  );
}

function compatibilityKey(source: AgentInstructionSource, scope: string): string {
  return `${scope}\0${source.name ?? source.path}`;
}

function scopeDepth(scope: string): number {
  return scope === '.' ? 0 : scope.split('/').length;
}
