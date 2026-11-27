import { describe, expect, it } from 'vitest';
import { UserRuleDirectory } from '#src/instructions/rules/UserRuleDirectory.js';
import { InstructionPaths } from '#src/instructions/InstructionPaths.js';
import { AgentInstructionSourceKind } from '#src/instructions/AgentInstructionSource.js';
import { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
describe(UserRuleDirectory, () => {
  it('associates the most specific eligible project scope with direct user-owned rule files', () => {
    const roots = [
      { name: 'parent', path: '/workspace' },
      { name: 'inside', path: '/workspace/a/.cursor' },
      { name: 'a', path: '/workspace/a' },
      { name: 'far', path: '/elsewhere/folder/outside' },
      { name: 'sibling', path: '/workspace/a/b' },
    ];
    const paths = new InstructionPaths(false, new WorkspaceSourceRoutes(roots));
    const directory = new UserRuleDirectory('/workspace/a/.cursor', false, roots, paths);
    expect(directory.ownsProjectRule('parent/a/.CURSOR/RULES/one.mdc')).toBe(true);
    expect(directory.ownsProjectRule('a/.glyph/rules/one.mdc')).toBe(false);
    expect(directory.ownsProjectRule('invalid')).toBe(false);
    expect(directory.projectAlias('rules')).toBeUndefined();
    expect(directory.projectAlias('rules/one.mdc')).toMatchObject({
      kind: AgentInstructionSourceKind.CURSOR_PROJECT_RULE,
      scope: 'a',
      legacyIds: expect.arrayContaining(['cursor_project_rule:.cursor/rules/one.mdc']),
    });
    expect(
      new UserRuleDirectory('/elsewhere/profile', true, roots, paths).projectAlias('rules/one.mdc'),
    ).toBeUndefined();
    expect(
      new UserRuleDirectory('/elsewhere/.GLYPH', true, roots, paths).projectAlias('rules/one.mdc'),
    ).toBeUndefined();
  });
});
