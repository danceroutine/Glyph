import { describe, expect, it } from 'vitest';
import { AgentInstructionSourceKind, AgentInstructionSourceStatus } from '#src/instructions/AgentInstructionSource.js';
import { globExpression, matchesAgentRulePath } from '#src/instructions/rules/matchesAgentRulePath.js';

describe(matchesAgentRulePath, () => {
  it('matches recursive and single-segment patterns only within scope', () => {
    const source = {
      id: 'rule',
      kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      label: 'Rule',
      path: 'packages/api/.glyph/rules/typescript.mdc',
      scope: 'packages/api',
      status: AgentInstructionSourceStatus.ACTIVE,
      globs: ['**/*.ts', 'config?.json'],
    };

    expect(matchesAgentRulePath(source, 'packages/api/src/main.ts')).toBe(true);
    expect(matchesAgentRulePath(source, 'packages/api/config1.json')).toBe(true);
    expect(matchesAgentRulePath(source, 'packages/web/src/main.ts')).toBe(false);
    expect(matchesAgentRulePath(source, 'packages/api/src/main.js')).toBe(false);
    const { globs: _globs, ...withoutGlobs } = source;
    expect(matchesAgentRulePath(withoutGlobs, 'packages/api')).toBe(false);
    expect(matchesAgentRulePath({ ...source, scope: '.', globs: ['src**.ts'] }, 'src-main.ts')).toBe(true);
  });

  it.each(['', '/absolute', '../outside', 'src\\file.ts', '{src,test}/**', '[ab].ts', '!secret'])(
    'rejects unsupported or unsafe glob %s',
    pattern => {
      expect(() => globExpression(pattern)).toThrow('Invalid rule glob');
    },
  );
});
