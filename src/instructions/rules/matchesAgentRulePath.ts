import type { AgentInstructionSource } from '#src/instructions/AgentInstructionSource.js';
import { defaultInstructionPaths, type InstructionPaths } from '#src/instructions/InstructionPaths.js';

interface GlobMatcher {
  test(path: string, budget?: RuleGlobBudget): boolean;
}

/** Bound the aggregate cost of evaluating all file-pattern rules for one disclosure. */
export class RuleGlobBudget {
  private remaining = 4_000_000;

  private readonly patterns = new Map<string, { matcher: GlobMatcher; results: Map<string, boolean> }>();

  matches(pattern: string, path: string, sensitive: boolean): boolean {
    const key = JSON.stringify([sensitive, pattern]);
    let evaluation = this.patterns.get(key);
    if (!evaluation) {
      evaluation = { matcher: globExpression(pattern, sensitive), results: new Map() };
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
    const normalized = (value: string) => paths.routes?.normalizeName(owner, value) ?? value;
    return source.globs?.some(pattern =>
      budget.matches(normalized(pattern), normalized(relative), paths.caseSensitive(owner)),
    );
  });
}

/** Each token visits each path position at most once, including consecutive wildcards. */
export function globExpression(pattern: string, sensitive = true): GlobMatcher {
  if (
    !pattern ||
    pattern.length > 512 ||
    pattern.startsWith('/') ||
    pattern.includes('..') ||
    /[\\[\]{}()!]/u.test(pattern)
  )
    throw new Error(`Invalid rule glob: ${pattern || '(empty)'}`);
  const normalized = sensitive ? pattern : pattern.toLowerCase();
  if (!/[?*]/u.test(normalized))
    return {
      test(path, budget) {
        budget?.spend(path.length + 1);
        return normalized === (sensitive ? path : path.toLowerCase());
      },
    };
  const tokens = normalized.match(/\*\*\/|\*\*|[\s\S]/gu)!;
  const literalPrefix = tokens
    .slice(
      0,
      tokens.findIndex(token => isWildcardToken(token)),
    )
    .join('');
  const suffix = tokens.slice(tokens.findLastIndex(token => isWildcardToken(token)) + 1).join('');
  return {
    test(path, budget) {
      const normalizedPath = sensitive ? path : path.toLowerCase();
      budget?.spend(normalizedPath.length + 1);
      if (!normalizedPath.startsWith(literalPrefix) || !normalizedPath.endsWith(suffix)) return false;
      budget?.spend(tokens.length * (normalizedPath.length + 1));
      const characters = Array.from(normalizedPath);
      let previous = new Uint8Array(characters.length + 1);
      let next = new Uint8Array(previous.length);
      previous[0] = 1;
      for (const token of tokens) {
        const star = token === '*' || token === '**';
        next[0] = star || token === '**/' ? previous[0]! : 0;
        let prefix = false;
        for (let index = 1; index <= characters.length; index++) {
          const char = characters[index - 1]!;
          prefix ||= previous[index - 1] === 1;
          if (token === '**/') next[index] = Number(previous[index] === 1 || (char === '/' && prefix));
          else if (star)
            next[index] = Number(previous[index] === 1 || (next[index - 1] === 1 && (token === '**' || char !== '/')));
          else next[index] = Number(previous[index - 1] === 1 && (token === '?' ? char !== '/' : token === char));
        }
        [previous, next] = [next, previous];
      }
      return previous[characters.length] === 1;
    },
  };
}

function isWildcardToken(token: string): boolean {
  return token.includes('*') || token === '?';
}
