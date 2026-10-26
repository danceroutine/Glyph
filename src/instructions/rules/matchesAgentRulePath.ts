import type { AgentInstructionSource } from '#src/instructions/AgentInstructionSource.js';

/** Match a project-relative path against one rule's validated scope and glob patterns. */
export function matchesAgentRulePath(source: AgentInstructionSource, path: string): boolean {
  if (!contains(source.scope, path)) return false;
  const relative = source.scope === '.' ? path : path.slice(source.scope.length + (path === source.scope ? 0 : 1));
  return (source.globs ?? []).some(pattern => globExpression(pattern).test(relative));
}

/** Validate and compile the bounded glob subset accepted by rule metadata. */
export function globExpression(pattern: string): RegExp {
  if (pattern === '' || pattern.startsWith('/') || pattern.includes('\\') || pattern.includes('..'))
    throw new Error(`Invalid rule glob: ${pattern || '(empty)'}`);
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') {
          index++;
          expression += '(?:.*/)?';
        } else expression += '.*';
      } else expression += '[^/]*';
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    if ('[]{}()!'.includes(character)) throw new Error(`Invalid rule glob: ${pattern}`);
    expression += character.replaceAll(/[.$^+|\\]/gu, '\\$&');
  }
  return new RegExp(`${expression}$`, 'u');
}

function contains(scope: string, path: string): boolean {
  return scope === '.' || path === scope || path.startsWith(`${scope}/`);
}
