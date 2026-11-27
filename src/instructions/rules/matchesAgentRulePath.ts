import { normalizeVolumeName, type FilesystemNamePolicy } from '#src/workspace/FilesystemNamePolicy.js';
import type { AgentInstructionSource } from '#src/instructions/AgentInstructionSource.js';
import { defaultInstructionPaths, type InstructionPaths } from '#src/instructions/InstructionPaths.js';

type GlobNamePolicy = Partial<FilesystemNamePolicy>;

type ConfirmLiteral = (component: number, literal: string) => boolean;

interface GlobLocation {
  readonly physical: string;
  readonly components: readonly FilesystemNamePolicy[] | undefined;
  readonly confirm: ConfirmLiteral;
}

interface GlobMatcher {
  test(path: string, budget?: RuleGlobBudget, location?: GlobLocation): boolean;
}

/** Bound the aggregate cost of evaluating all file-pattern rules for one disclosure. */
export class RuleGlobBudget {
  private remaining = 4_000_000;

  private readonly patterns = new Map<string, { matcher: GlobMatcher; results: Map<string, boolean> }>();

  private readonly spellings = new Map<string, string>();
  storedSpelling(route: string, paths: InstructionPaths): string {
    const cached = this.spellings.get(route);
    if (cached !== undefined) return cached;
    const stored = paths.routes?.storedSpelling(route) ?? route;
    this.spellings.set(route, stored);
    return stored;
  }

  matches(
    pattern: string,
    path: string,
    sensitive: boolean,
    policy?: GlobNamePolicy,
    location?: GlobLocation,
  ): boolean {
    const key = JSON.stringify([sensitive, policy?.normalizesUnicode, policy?.foldsUnicode, pattern]);
    let evaluation = this.patterns.get(key);
    if (!evaluation) {
      evaluation = { matcher: globExpression(pattern, sensitive, policy), results: new Map() };
      this.patterns.set(key, evaluation);
    }
    const candidate = location === undefined ? path : location.physical + '\0' + path;
    const cached = evaluation.results.get(candidate);
    if (cached !== undefined) return cached;
    const matched = evaluation.matcher.test(path, this, location);
    evaluation.results.set(candidate, matched);
    return matched;
  }

  spend(work: number): void {
    this.remaining -= work;
    if (this.remaining < 0)
      throw new Error(
        'Rule glob matching exceeded the per-disclosure work limit. Narrow the applicable globs or reduce the paths and retry.',
      );
  }
}

/** Resolve each participating scope and evaluate shared rule patterns once per disclosure. */
export class RulePathBatch {
  private readonly scopes = new Map<string, ReturnType<RulePathBatch['resolveScope']>>();
  private readonly inputsByScope = new Map<string, string[]>();
  constructor(
    private readonly inputs: readonly string[],
    private readonly paths: InstructionPaths,
    private readonly budget = new RuleGlobBudget(),
  ) {
    paths.prepare(inputs);
    for (const path of inputs) {
      for (const key of paths.ancestorKeys(path)) {
        const bucket = this.inputsByScope.get(key);
        if (bucket) bucket.push(path);
        else this.inputsByScope.set(key, [path]);
      }
    }
  }

  get scopeKeys(): Iterable<string> {
    return this.inputsByScope.keys();
  }

  matching(scope: string, globs?: readonly string[]): readonly string[] {
    let resolved = this.scopes.get(scope);
    if (!resolved) {
      resolved = this.resolveScope(scope);
      this.scopes.set(scope, resolved);
    }
    if (!globs) return resolved.paths;
    const key = JSON.stringify(globs);
    let matches = resolved.selections.get(key);
    if (!matches) {
      matches = resolved.paths.filter((_path, index) => globs.some(pattern => resolved.matches(index, pattern)));
      resolved.selections.set(key, matches);
    }
    return matches;
  }

  private resolveScope(scope: string) {
    const paths = scope === '.' ? this.inputs : (this.inputsByScope.get(this.paths.key(scope)) ?? []);
    const routes = new Map<number, ReturnType<RulePathBatch['resolveRoutes']>>();
    const patterns = new Map<string, Map<number, boolean>>();
    const matches = (index: number, pattern: string): boolean => {
      let results = patterns.get(pattern);
      if (!results) {
        results = new Map();
        patterns.set(pattern, results);
      }
      const cached = results.get(index);
      if (cached !== undefined) return cached;
      let resolved = routes.get(index);
      if (!resolved) {
        resolved = this.resolveRoutes(scope, paths[index]!);
        routes.set(index, resolved);
      }
      const result = resolved.some(matchesRoute => matchesRoute(pattern));
      results.set(index, result);
      return result;
    };
    return { paths, matches, selections: new Map<string, readonly string[]>() };
  }

  private resolveRoutes(scope: string, path: string) {
    const paths = this.paths;
    const routes = paths.equivalents(path);
    const scopeKey = paths.key(scope);
    return routes
      .filter(route => scope === '.' || paths.key(route) === scopeKey || paths.key(route).startsWith(scopeKey + '/'))
      .map(route => {
        const relative =
          scope === '.'
            ? paths.relativeToScope(scope, route)
            : route.split('/').slice(scope.split('/').length).join('/');
        const policy = paths.routes?.namePolicy(route);
        const sensitive = paths.caseSensitive(route);
        const policies = paths.routes?.componentPolicies(route)?.slice(-relative.split('/').length);
        const physical = paths.routes?.physicalPath(route);
        const components = relative.split('/');
        const root = route.split('/')[0]!;
        const base = scope === '.' && paths.isWorkspaceRoot(root) ? root : scope;
        const confirm: ConfirmLiteral = (index, literal) => {
          const prefix = [...components.slice(0, index), literal].join('/');
          return paths.contains(paths.reference(base, prefix), route);
        };
        const location = physical === undefined ? undefined : { physical, components: policies, confirm };
        let stored: string | undefined;
        return (pattern: string): boolean => {
          const candidate = pattern.includes('?')
            ? (stored ??= paths.relativeToScope(scope, this.budget.storedSpelling(route, paths)))
            : relative;
          return this.budget.matches(pattern, candidate, sensitive, policy, location);
        };
      });
  }
}

/** Match one source outside a shared disclosure batch. */
export function matchesAgentRulePath(
  source: AgentInstructionSource,
  path: string,
  paths: InstructionPaths = defaultInstructionPaths,
  budget = new RuleGlobBudget(),
): boolean {
  return new RulePathBatch([path], paths, budget).matching(source.scope, source.globs ?? []).length > 0;
}

/**
 * Wildcards advance between stored Unicode scalars. A literal run may span a different number of
 * scalars in the pattern and the file (for example, SS and ß on a folding volume).
 */
export function globExpression(pattern: string, sensitive = true, policy?: GlobNamePolicy): GlobMatcher {
  if (
    !pattern ||
    pattern.length > 512 ||
    pattern.startsWith('/') ||
    pattern.includes('..') ||
    /[\\[\]{}()!]/u.test(pattern)
  )
    throw new Error(`Invalid rule glob: ${pattern || '(empty)'}`);
  const comparison = (value: string, owner?: GlobNamePolicy): string => {
    const normalized = normalizeVolumeName(value, owner);
    return (owner?.caseSensitive ?? sensitive) ? normalized : normalized.toLowerCase();
  };
  const countsStoredCharacters = pattern.includes('?');
  const raw = pattern.match(/\*\*\/|\*\*|[?*/]|[^?*/]+/gu)!;
  const complete = raw.map(
    (token, i) =>
      !/[?*/]/u.test(token) && (i === 0 || raw[i - 1]!.endsWith('/')) && (i === raw.length - 1 || raw[i + 1] === '/'),
  );
  const compiled = new Map<GlobNamePolicy | undefined, { literal: string; width: number }[]>();
  const literals = (owner?: GlobNamePolicy) => {
    let result = compiled.get(owner);
    if (!result) {
      result = raw.map(token => {
        const literal = comparison(token, owner);
        return { literal, width: literal.normalize('NFD').length };
      });
      compiled.set(owner, result);
    }
    return result;
  };
  return {
    test(storedPath, budget, location) {
      const parts = storedPath.split('/');
      const confirmed = (i: number, expected: string) =>
        parts[i] === expected || !location || location.confirm(i, expected);
      if (!/[?*]/u.test(pattern)) {
        budget?.spend(storedPath.length + 1);
        const expected = pattern.split('/');
        return (
          parts.length === expected.length &&
          parts.every((part, i) => {
            const owner = location?.components?.[i] ?? policy;
            return comparison(expected[i]!, owner) === comparison(part, owner) && confirmed(i, expected[i]!);
          })
        );
      }
      const characters: string[] = [];
      const owners: (GlobNamePolicy | undefined)[] = [];
      const segment: number[] = [];
      const offsets = [0];
      const widths = [0];
      const boundaries = new Map([[0, 0]]);
      for (const [i, part] of parts.entries()) {
        const owner = location?.components?.[i] ?? policy;
        const spelling = countsStoredCharacters ? part : comparison(part, owner);
        for (const character of (i ? '/' : '') + spelling) {
          characters.push(character);
          owners.push(owner);
          segment.push(i);
          offsets.push(offsets.at(-1)! + character.length);
          const width = widths.at(-1)! + comparison(character, owner).normalize('NFD').length;
          widths.push(width);
          boundaries.set(width, characters.length);
        }
      }
      const path = characters.join('');
      budget?.spend(path.length + 1);
      const runStart = (token: number, end: number) => {
        const owner = owners[end - 1];
        const { literal, width } = literals(owner)[token]!;
        const start = boundaries.get(widths[end]! - width);
        if (start === undefined) return -1;
        budget?.spend(offsets[end]! - offsets[start]!);
        if (comparison(path.slice(offsets[start], offsets[end]), owner) !== literal) return -1;
        if (
          complete[token] &&
          (start === 0 || characters[start - 1] === '/') &&
          (end === characters.length || characters[end] === '/') &&
          !confirmed(segment[end - 1]!, raw[token]!)
        )
          return -1;
        return start;
      };
      const first = raw[0];
      if (!/[?*]/u.test(first)) {
        const end = boundaries.get(literals(owners[0])[0]!.width);
        if (end === undefined || runStart(0, end) !== 0) return false;
      }
      const last = raw.length - 1;
      if (!/[?*]/u.test(raw[last]!) && runStart(last, characters.length) < 0) return false;
      budget?.spend(raw.length * (characters.length + 1));
      let previous = new Uint8Array(characters.length + 1);
      let next = new Uint8Array(previous.length);
      previous[0] = 1;
      for (const [t, token] of raw.entries()) {
        const star = token === '*' || token === '**';
        next[0] = star || token === '**/' ? previous[0]! : 0;
        let prefix = false;
        for (let index = 1; index <= characters.length; index++) {
          const char = characters[index - 1]!;
          prefix ||= previous[index - 1] === 1;
          if (token === '**/') next[index] = Number(previous[index] === 1 || (char === '/' && prefix));
          else if (star)
            next[index] = Number(previous[index] === 1 || (next[index - 1] === 1 && (token === '**' || char !== '/')));
          else if (token === '?') next[index] = Number(previous[index - 1] === 1 && char !== '/');
          else {
            const owner = owners[index - 1];
            const start = boundaries.get(widths[index]! - literals(owner)[t]!.width);
            next[index] = Number(start !== undefined && previous[start] === 1 && runStart(t, index) === start);
          }
        }
        [previous, next] = [next, previous];
      }
      return previous[characters.length] === 1;
    },
  };
}
