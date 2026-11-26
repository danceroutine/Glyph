import type { AgentInstructionSource } from '#src/instructions/AgentInstructionSource.js';
import { defaultInstructionPaths, type InstructionPaths } from '#src/instructions/InstructionPaths.js';

interface GlobMatcher {
  test(path: string, budget?: RuleGlobBudget): boolean;
}
const compiledSources = new WeakMap<AgentInstructionSource, Map<boolean, readonly GlobMatcher[]>>();

/** Bound the aggregate cost of evaluating all file-pattern rules for one disclosure. */
export class RuleGlobBudget {
  private remaining = 4_000_000;

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
  budget.spend(path.length + 1);
  const relative = paths.relativeToScope(source.scope, path);
  const sensitive = paths.caseSensitive(path);
  const cache = compiledSources.get(source) ?? new Map<boolean, readonly GlobMatcher[]>();
  const matchers =
    cache.get(sensitive) ?? [...new Set(source.globs ?? [])].map(pattern => globExpression(pattern, sensitive));
  cache.set(sensitive, matchers);
  compiledSources.set(source, cache);
  return matchers.some(matcher => matcher.test(relative, budget));
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
  const wildcard = (token: string) => token.includes('*') || token === '?';
  const prefix = tokens.slice(0, tokens.findIndex(wildcard)).join('');
  const suffix = tokens.slice(tokens.findLastIndex(wildcard) + 1).join('');
  return {
    test(path, budget) {
      const normalizedPath = sensitive ? path : path.toLowerCase();
      budget?.spend(normalizedPath.length + 1);
      if (!normalizedPath.startsWith(prefix) || !normalizedPath.endsWith(suffix)) return false;
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
