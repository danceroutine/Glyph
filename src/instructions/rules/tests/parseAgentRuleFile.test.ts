import { describe, expect, it } from 'vitest';
import { AgentInstructionActivationMode } from '#src/instructions/AgentInstructionSource.js';
import { parseAgentRuleFile } from '#src/instructions/rules/parseAgentRuleFile.js';

describe(parseAgentRuleFile, () => {
  it('parses native activation, lists, booleans, quoted values, and Markdown bodies', () => {
    expect(
      parseAgentRuleFile(`---
name: "TypeScript"
description: Use for TypeScript files
activation: file-pattern
globs:
  - "**/*.ts"
  - '*.tsx'
enabled: false
references: [docs/style.md, "docs/testing.md"]
---
Use strict types.
`),
    ).toEqual({
      name: 'TypeScript',
      description: 'Use for TypeScript files',
      activation: AgentInstructionActivationMode.FILE_PATTERN,
      globs: ['**/*.ts', '*.tsx'],
      enabled: false,
      references: ['docs/style.md', 'docs/testing.md'],
      body: 'Use strict types.\n',
    });
  });

  it('accepts Markdown without frontmatter as a manual-compatible rule body', () => {
    expect(parseAgentRuleFile('Review accessibility.')).toEqual({
      globs: [],
      enabled: true,
      references: [],
      body: 'Review accessibility.',
    });
  });

  it('supports CRLF, comments, empty lists, scalar lists, and legacy alwaysApply metadata', () => {
    expect(
      parseAgentRuleFile(
        "---\r\n# comment\r\nname: 'Legacy'\r\ndescription: value: # comment\r\nalwaysApply: true\r\nglobs: '*.ts'\r\nreferences: []\r\n---\r\nBody",
      ),
    ).toEqual({
      name: 'Legacy',
      description: 'value:',
      globs: ['*.ts'],
      alwaysApply: true,
      enabled: true,
      references: [],
      body: 'Body',
    });
    expect(parseAgentRuleFile('---\nglobs: ""\n---\nBody').globs).toEqual([]);
    expect(parseAgentRuleFile('---\nname: " "\n---\nBody')).not.toHaveProperty('name');
  });

  it.each([
    ['missing delimiter', '---\ndescription: broken'],
    ['duplicate property', '---\nname: one\nname: two\n---\nbody'],
    ['orphan list item', '---\n- one\n---\nbody'],
    ['unknown activation', '---\nactivation: sometimes\n---\nbody'],
    ['boolean as string', '---\nenabled: yes\n---\nbody'],
    ['invalid glob', '---\nglobs: [../outside]\n---\nbody'],
    ['broken inline list', '---\nglobs: [*.ts\n---\nbody'],
    ['long description', `---\ndescription: ${'x'.repeat(2001)}\n---\nbody`],
    ['list continuation after scalar', '---\nname: one\n  - two\n---\nbody'],
    ['invalid line', '---\nnot valid\n---\nbody'],
    ['non-string description', '---\ndescription: true\n---\nbody'],
    ['non-boolean alwaysApply', '---\nalwaysApply: yes\n---\nbody'],
    ['non-list globs', '---\nglobs: true\n---\nbody'],
  ])('rejects %s', (_name, value) => {
    expect(() => parseAgentRuleFile(value)).toThrow();
  });
});
