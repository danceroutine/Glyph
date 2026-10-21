import { describe, expect, it } from 'vitest';
import { AgentMode, AgentModeID } from '#src/chat/AgentMode.js';

describe(AgentMode, () => {
  it('resolves every serializable ID to one immutable mode', () => {
    expect(AgentMode.all.map(mode => mode.id)).toEqual(Object.values(AgentModeID));
    for (const mode of AgentMode.all) {
      expect(AgentMode.resolve(JSON.parse(JSON.stringify(mode.id)))).toBe(mode);
      expect(Object.isFrozen(mode)).toBe(true);
    }
    expect(Object.isFrozen(AgentMode.all)).toBe(true);
  });
  it.each(['unknown', '__proto__', 'toString', '', null, undefined])('rejects unknown mode %s', value => {
    expect(AgentMode.isId(value)).toBe(false);
    expect(() => AgentMode.resolve(value as AgentModeID)).toThrow('Unknown conversation mode');
  });
  it.each([
    ['plan.md', true],
    ['notes.MARKDOWN', true],
    ['/workspace/plan.md', true],
    ['plan.md.ts', false],
    ['src/index.ts', false],
    ['README', false],
  ])('applies the Plan edit policy to %s', (path, allowed) => {
    const plan = AgentMode.resolve(AgentModeID.PLAN);
    expect(plan.getEditDenial(path) === undefined).toBe(allowed);
    expect(AgentMode.resolve(AgentModeID.AGENT).getEditDenial(path)).toBeUndefined();
  });
  it('titles each mode and reports whether it restricts edits', () => {
    expect(AgentMode.resolve(AgentModeID.AGENT).title).toBe('Agent Mode');
    expect(AgentMode.resolve(AgentModeID.PLAN).title).toBe('Plan Mode');
    expect(AgentMode.resolve(AgentModeID.AGENT).restrictsEdits).toBe(false);
    expect(AgentMode.resolve(AgentModeID.PLAN).restrictsEdits).toBe(true);
  });
});
