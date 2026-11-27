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

it('keeps each independently indexed name of an individual user rule for historical navigation and scope precedence', async () => {
  const { mkdtemp, mkdir, writeFile, link, rm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-rule-aliases-')));
  try {
    const profile = join(root, 'profile');
    const store = join(profile, 'rules');
    const source = join(store, 'personal.mdc');
    const glyph = join(root, 'outer', '.glyph', 'rules', 'one.mdc');
    const cursor = join(root, 'inner', '.cursor', 'rules', 'two.mdc');
    for (const directory of [store, join(root, 'outer/.glyph/rules'), join(root, 'inner/.cursor/rules')])
      await mkdir(directory, { recursive: true });
    await writeFile(source, 'rule');
    await link(source, glyph);
    await link(source, cursor);
    const roots = [{ name: 'project', path: root }];
    const paths = new InstructionPaths(true, new WorkspaceSourceRoutes(roots));
    const directory = new UserRuleDirectory(profile, true, roots, paths, () => [store, glyph, cursor]);
    directory.refresh();
    expect(directory.ownsProjectRule('outer/.glyph/rules/one.mdc')).toBe(true);
    expect(directory.ownsProjectRule('inner/.cursor/rules/two.mdc')).toBe(true);
    const alias = directory.projectAlias('rules/personal.mdc');
    expect(alias).toMatchObject({
      kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      scope: 'outer',
      additionalScopes: [{ kind: AgentInstructionSourceKind.CURSOR_PROJECT_RULE, scope: 'inner' }],
    });
    expect(alias?.legacyIds).toContain(
      paths.sourceIdentity(AgentInstructionSourceKind.CURSOR_PROJECT_RULE, 'inner/.cursor/rules/two.mdc').id,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
