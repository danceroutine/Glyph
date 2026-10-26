import { describe, expect, it } from 'vitest';
import { AgentInstructionSet } from '#src/instructions/AgentInstructionSet.js';
import {
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
  type AgentInstructionSource,
} from '#src/instructions/AgentInstructionSource.js';

function anInstructionSource(overrides: Partial<AgentInstructionSource> = {}): AgentInstructionSource {
  return {
    id: 'root',
    kind: AgentInstructionSourceKind.AGENTS_MD,
    label: 'AGENTS.md',
    path: 'AGENTS.md',
    scope: '.',
    status: AgentInstructionSourceStatus.ACTIVE,
    ...overrides,
  };
}

describe(AgentInstructionSet, () => {
  it('preserves family precedence within scope buckets and isolates returned arrays', () => {
    const root = anInstructionSource();
    const guidance = anInstructionSource({ id: 'guidance', scope: 'src', path: 'src/AGENTS.md' });
    const rule = anInstructionSource({
      id: 'rule',
      kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      scope: 'src',
      path: 'src/.glyph/rules/types.mdc',
      enabled: false,
    });
    const set = new AgentInstructionSet([guidance, root, rule]);

    expect(set.forPath('.')).toEqual([root]);
    expect(set.forPath('src/file.ts')).toEqual([root, rule, guidance]);
    expect(set.forPath('unrelated/file.ts')).toEqual([root]);
    expect(new AgentInstructionSet([rule]).forPath('src/file.ts')).toEqual([rule]);
    expect(new AgentInstructionSet([]).forPath('file.ts')).toEqual([]);

    // Callers may own and change the result array without changing the scope index.
    const result = set.forPath('src/file.ts') as AgentInstructionSource[];
    result.splice(0);
    expect(set.forPath('src/file.ts')).toEqual([root, rule, guidance]);
  });

  it('resolves ancestors in precedence order without matching sibling directory prefixes', () => {
    const root = anInstructionSource();
    const near = anInstructionSource({ id: 'near', scope: 'src', path: 'src/AGENTS.md' });
    const deeper = anInstructionSource({ id: 'deep', scope: 'src/lib', path: 'src/lib/AGENTS.md' });
    const sibling = anInstructionSource({ id: 'sibling', scope: 'src-old', path: 'src-old/AGENTS.md' });
    const error = anInstructionSource({ id: 'error', status: AgentInstructionSourceStatus.ERROR });
    const input = [deeper, sibling, near, error, root];
    const set = new AgentInstructionSet(input);

    expect(set.forPath('src/lib/file.ts')).toEqual([root, near, deeper]);
    expect(set.forPath('src')).toEqual([root, near]);
    expect(set.forPath('src-old/file.ts')).toEqual([root, sibling]);
    expect(set.sources).toContain(error);
    expect(input).toEqual([deeper, sibling, near, error, root]);
  });

  it('shadows compatible rules only when both name and scope match', () => {
    const native = anInstructionSource({
      id: 'native',
      kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      path: '.glyph/rules/shared.mdc',
      name: 'Shared',
    });
    const compatible = anInstructionSource({
      id: 'compatible',
      kind: AgentInstructionSourceKind.CURSOR_PROJECT_RULE,
      path: '.cursor/rules/shared.mdc',
      name: 'Shared',
    });
    const nested = { ...compatible, id: 'nested', scope: 'src', path: 'src/.cursor/rules/shared.mdc' };
    const different = { ...compatible, id: 'different', name: 'Different' };

    expect(new AgentInstructionSet([compatible, nested, different, native]).sources).toEqual([
      different,
      native,
      nested,
    ]);
  });

  it('retains native shadowing when the native source is disabled or unreadable', () => {
    const native = anInstructionSource({
      kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      path: '.glyph/rules/shared.mdc',
      name: 'Shared',
      enabled: false,
    });
    const compatible = { ...native, kind: AgentInstructionSourceKind.CURSOR_PROJECT_RULE, enabled: true };
    const error = { ...native, status: AgentInstructionSourceStatus.ERROR };

    expect(new AgentInstructionSet([compatible, native]).sources).toEqual([native]);
    expect(new AgentInstructionSet([compatible, error]).sources).toEqual([error]);
  });
});
