import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstructionPaths } from '#src/instructions/InstructionPaths.js';
import { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
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

  it('counts stored characters in wildcards and compares each literal run with its volume policy', () => {
    const folding = { normalizesUnicode: true, foldsUnicode: true };
    const matches = (pattern: string, path: string) => globExpression(pattern, false, folding).test(path);
    expect(matches('SS/?.txt', 'ß/ß.txt')).toBe(true);
    expect(matches('ß/??.txt', 'ß/ß.txt')).toBe(false);
    expect(matches('ß/?.txt', 'SS/ß.txt')).toBe(true);
    expect(matches('*SS?ff', '📜ß💛ﬀ')).toBe(true);
    expect(matches('?FF', 'ßﬀ')).toBe(true);
    expect(matches('S*', 'ß')).toBe(true);
    expect(matches('s?', 'ß')).toBe(false);
    expect(matches('?s', 'ß')).toBe(false);
    expect(matches('?s?', 'ßSx')).toBe(true);
    expect(matches('?', 'e\u0301')).toBe(false);
    expect(matches('??', 'e\u0301')).toBe(true);
    expect(matches('e?', 'e\u0301')).toBe(true);
    expect(matches('é?', 'e\u0301A')).toBe(true);
    expect(matches('?é', 'Ae\u0301')).toBe(true);
    expect(matches('ß'.repeat(510) + '?', 'ss'.repeat(510) + 'X')).toBe(true);
    expect(matches('x' + '*'.repeat(235) + '?.ts', 'x'.repeat(400) + '.ts')).toBe(true);
    expect(matches('ß?', 'ß/')).toBe(false);
    expect(globExpression('SS/?.txt', true, { normalizesUnicode: true }).test('ß/ß.txt')).toBe(false);
    expect(globExpression('é?', true).test('e\u0301x')).toBe(false);
    expect(globExpression('ß/??.txt', true).test('ß/ss.txt')).toBe(true);
  });

  it('resolves a file-pattern rule against the actual directory entries on the mounted volume', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'glyph-rule-character-width-')));
    try {
      mkdirSync(join(root, 'ß'));
      writeFileSync(join(root, 'ß/ß.txt'), 'stored');
      writeFileSync(join(root, 'e\u0301'), 'stored decomposed');
      const foldsUnicode = existsSync(join(root, 'SS/ss.txt'));
      const normalizesUnicode = existsSync(join(root, 'é'));
      const routes = new WorkspaceSourceRoutes([{ name: 'workspace', path: root, normalizesUnicode, foldsUnicode }]);
      const paths = new InstructionPaths(!foldsUnicode, routes);
      const matches = (glob: string, path: string) =>
        matchesAgentRulePath(
          {
            id: 'rule',
            label: 'Rule',
            path: 'rules/rule.mdc',
            scope: '.',
            kind: AgentInstructionSourceKind.GLYPH_USER_RULE,
            status: AgentInstructionSourceStatus.ACTIVE,
            globs: [glob],
          },
          path,
          paths,
        );
      expect(matches('SS/?.txt', 'ß/ß.txt')).toBe(foldsUnicode);
      expect(matches('ß/?.txt', 'ß/ß.txt')).toBe(true);
      expect(matches('ß/??.txt', 'ß/ß.txt')).toBe(false);
      if (foldsUnicode) {
        expect(matches('SS/?.txt', 'SS/ss.txt')).toBe(true);
      } else {
        mkdirSync(join(root, 'SS'));
        writeFileSync(join(root, 'SS/ss.txt'), 'distinct');
        expect(matches('SS/??.txt', 'SS/ss.txt')).toBe(true);
      }
      expect(matches('ß/??.txt', 'SS/ss.txt')).toBe(false);
      if (normalizesUnicode) {
        expect(matches('?', 'é')).toBe(false);
        expect(matches('??', 'é')).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
