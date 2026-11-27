import { normalizeVolumeName, type FilesystemNamePolicy } from '#src/workspace/FilesystemNamePolicy.js';
import type { AgentInstructionSource } from '#src/instructions/AgentInstructionSource.js';
import { defaultInstructionPaths, type InstructionPaths } from '#src/instructions/InstructionPaths.js';

type GlobNamePolicy = Partial<Pick<FilesystemNamePolicy, 'normalizesUnicode' | 'foldsUnicode'>>;

interface GlobMatcher {
  test(path: string, budget?: RuleGlobBudget): boolean;
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

  matches(pattern: string, path: string, sensitive: boolean, policy?: GlobNamePolicy): boolean {
    const key = JSON.stringify([sensitive, policy?.normalizesUnicode, policy?.foldsUnicode, pattern]);
    let evaluation = this.patterns.get(key);
    if (!evaluation) {
      evaluation = { matcher: globExpression(pattern, sensitive, policy), results: new Map() };
      this.patterns.set(key, evaluation);
    }
    const cached = evaluation.results.get(path);
    if (cached !== undefined) return cached;
    const matched = evaluation.matcher.test(path, this);
    evaluation.results.set(path, matched);
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

/** Match the rule against a path using the target root's filesystem casing. */
export function matchesAgentRulePath(
  source: AgentInstructionSource,
  path: string,
  paths: InstructionPaths = defaultInstructionPaths,
  budget = new RuleGlobBudget(),
): boolean {
  if (!paths.contains(source.scope, path)) return false;
  const routes = source.scope === '.' ? paths.equivalents(path) : [path];
  return routes.some(route => {
    const relative = paths.relativeToScope(source.scope, route);
    const owner = source.scope === '.' ? route : source.scope;
    const policy = paths.routes?.namePolicy(owner);
    return source.globs?.some(pattern => {
      const sensitive = paths.caseSensitive(owner);
      const candidate = pattern.includes('?')
        ? paths.relativeToScope(source.scope, budget.storedSpelling(route, paths))
        : relative;
      const matched = budget.matches(pattern, candidate, sensitive, policy);
      if (!matched || !paths.routes) return matched;
      const components = pattern.split('/');
      const wildcard = components.findIndex(component => /[?*]/u.test(component));
      const prefix = (wildcard < 0 ? components : components.slice(0, wildcard)).join('/');
      if (!prefix || relative === prefix || relative.startsWith(prefix + '/')) return true;
      const root = route.split('/')[0]!;
      const scope = source.scope === '.' && paths.isWorkspaceRoot(root) ? root : source.scope;
      return paths.contains(paths.reference(scope, prefix), route);
    });
  });
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
  const key = (value: string) => {
    const normalized = normalizeVolumeName(value, policy);
    return sensitive ? normalized : normalized.toLowerCase();
  };
  if (!/[?*]/u.test(pattern)) {
    const literal = key(pattern);
    return {
      test(path, budget) {
        budget?.spend(path.length + 1);
        return literal === key(path);
      },
    };
  }
  const countsStoredCharacters = pattern.includes('?');
  const tokenPattern = countsStoredCharacters ? pattern : key(pattern);
  const tokens = tokenPattern.match(/\*\*\/|\*\*|[?*]|[^?*]+/gu)!.map(token => {
    const literal = key(token);
    return { token, literal, width: literal.normalize('NFD').length };
  });
  return {
    test(storedPath, budget) {
      // Star-only patterns retain their ordinary volume-normalized matching. A question mark requires stored boundaries.
      const path = countsStoredCharacters ? storedPath : key(storedPath);
      budget?.spend(path.length + 1);
      const characters = Array.from(path);
      const offsets = [0];
      const widths = [0];
      const boundaries = new Map([[0, 0]]);
      // Canonical decomposition preserves total width across composition and reordering.
      // Index by that width, then compare the complete candidate run under the actual volume policy.
      for (const [index, character] of characters.entries()) {
        offsets.push(offsets[index]! + character.length);
        const width = widths[index]! + key(character).normalize('NFD').length;
        widths.push(width);
        boundaries.set(width, index + 1);
      }
      const equalsRun = (start: number, end: number, literal: string) => {
        budget?.spend(offsets[end]! - offsets[start]!);
        return key(path.slice(offsets[start], offsets[end])) === literal;
      };
      const first = tokens[0]!;
      if (!/[?*]/u.test(first.token)) {
        const end = boundaries.get(first.width);
        if (end === undefined || !equalsRun(0, end, first.literal)) return false;
      }
      const last = tokens.at(-1)!;
      if (!/[?*]/u.test(last.token)) {
        const start = boundaries.get(widths[characters.length]! - last.width);
        if (start === undefined || !equalsRun(start, characters.length, last.literal)) return false;
      }
      budget?.spend(tokens.length * (characters.length + 1));
      let previous = new Uint8Array(characters.length + 1);
      let next = new Uint8Array(previous.length);
      previous[0] = 1;
      for (const { token, literal, width } of tokens) {
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
            const start = boundaries.get(widths[index]! - width);
            next[index] = Number(start !== undefined && previous[start] === 1 && equalsRun(start, index, literal));
          }
        }
        [previous, next] = [next, previous];
      }
      return previous[characters.length] === 1;
    },
  };
}
