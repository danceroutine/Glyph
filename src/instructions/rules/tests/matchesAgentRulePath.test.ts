import { describe, expect, it } from 'vitest';
import { AgentInstructionSourceKind, AgentInstructionSourceStatus } from '#src/instructions/AgentInstructionSource.js';
import { globExpression, matchesAgentRulePath, RuleGlobBudget } from '#src/instructions/rules/matchesAgentRulePath.js';

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

  it('handles overlapping wildcards in bounded work and caps metadata complexity', () => {
    expect(globExpression('a*'.repeat(140) + 'z').test('a'.repeat(350))).toBe(false);
    expect(globExpression('**/ß?.ts').test('a/ß🟡.ts')).toBe(true);
    expect(globExpression('**/a').test('a')).toBe(true);
    expect(globExpression('**/a').test('ba')).toBe(false);
    expect(() => globExpression('a'.repeat(513))).toThrow('Invalid rule glob');
  });
  it.each(['', '/absolute', '../outside', 'src\\file.ts', '{src,test}/**', '[ab].ts', '!secret'])(
    'rejects unsupported or unsafe glob %s',
    pattern => {
      expect(() => globExpression(pattern)).toThrow('Invalid rule glob');
    },
  );
});

it('reuses each evaluation across distinct rules and matches workspace-wide rules through overlapping roots', async () => {
  const { InstructionPaths } = await import('#src/instructions/InstructionPaths.js');
  const { WorkspaceSourceRoutes } = await import('#src/workspace/WorkspaceSourceRoutes.js');
  const roots = [
    { name: 'Repo', path: '/repo' },
    { name: 'App', path: '/repo/sub' },
  ];
  const paths = new InstructionPaths(new Map(roots.map(root => [root.name, true])), new WorkspaceSourceRoutes(roots));
  const rule = {
    kind: AgentInstructionSourceKind.GLYPH_USER_RULE,
    scope: '.',
    path: 'rules/src.mdc',
    label: 'src',
    id: 'src',
    status: AgentInstructionSourceStatus.ACTIVE,
    globs: ['src/**/*.ts'],
  };
  const budget = new RuleGlobBudget();
  expect(matchesAgentRulePath(rule, 'Repo/sub/src/file.ts', paths, budget)).toBe(true);
  expect(matchesAgentRulePath({ ...rule, id: 'duplicate' }, 'App/src/file.ts', paths, budget)).toBe(true);
  budget.spend(3_999_000);
  for (let i = 0; i < 500; i++)
    expect(matchesAgentRulePath({ ...rule, id: String(i) }, 'Repo/sub/src/file.ts', paths, budget)).toBe(true);
});
