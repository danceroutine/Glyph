import type { AgentInstructionSource } from '#src/instructions/AgentInstructionSource.js';
import { defaultInstructionPaths, type InstructionPaths } from '#src/instructions/InstructionPaths.js';

interface GlobMatcher {
  test(path: string): boolean;
}
const compiledSources = new WeakMap<AgentInstructionSource, Map<boolean, readonly GlobMatcher[]>>();

/** Match the rule against a path using the target root's filesystem casing. */
export function matchesAgentRulePath(
  source: AgentInstructionSource,
  path: string,
  paths: InstructionPaths = defaultInstructionPaths,
): boolean {
  if (!paths.contains(source.scope, path)) return false;
  const relative = source.scope === '.' ? path : path.split('/').slice(source.scope.split('/').length).join('/');
  const sensitive = paths.caseSensitive(path);
  const cache = compiledSources.get(source) ?? new Map<boolean, readonly GlobMatcher[]>();
  const matchers = cache.get(sensitive) ?? (source.globs ?? []).map(pattern => globExpression(pattern, sensitive));
  cache.set(sensitive, matchers);
  compiledSources.set(source, cache);
  return matchers.some(matcher => matcher.test(relative));
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
  const tokens = (sensitive ? pattern : pattern.toLowerCase()).match(/\*\*\/|\*\*|[\s\S]/gu)!;
  return {
    test(path) {
      const characters = Array.from(sensitive ? path : path.toLowerCase());
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
