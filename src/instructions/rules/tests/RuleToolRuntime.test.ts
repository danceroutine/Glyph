import { describe, expect, it, vi } from 'vitest';
import { RuleToolRuntime } from '#src/instructions/rules/RuleToolRuntime.js';

describe(RuleToolRuntime, () => {
  it('activates a catalog rule through the current logical turn', async () => {
    const activateRule = vi.fn().mockReturnValue({
      schema: 'glyph.agent-instructions.v1',
      sources: [{ id: 'rule', content: 'instructions' }],
    });
    const runtime = new RuleToolRuntime({ activateRule });

    const output = JSON.parse(
      await runtime.tools[0]!.execute(JSON.stringify({ id: 'rule' }), new AbortController().signal, { turnId: 'turn' }),
    );

    expect(activateRule).toHaveBeenCalledWith('turn', 'rule');
    expect(output).toMatchObject({ activated: true, instructionContext: { sources: [{ id: 'rule' }] } });
  });

  it('does not disclose unavailable or repeated rules', async () => {
    const runtime = new RuleToolRuntime({ activateRule: vi.fn() });
    const output = JSON.parse(
      await runtime.tools[0]!.execute(JSON.stringify({ id: 'missing' }), new AbortController().signal, {
        turnId: 'turn',
      }),
    );
    expect(output).toMatchObject({ activated: false });
  });

  it('validates inputs and requires an active turn', async () => {
    const runtime = new RuleToolRuntime({ activateRule: vi.fn() });
    expect(() => {
      runtime.tools[0]!.validateInput?.('{"id":""}');
    }).toThrow();
    const output = JSON.parse(await runtime.tools[0]!.execute('{"id":"rule"}', new AbortController().signal, {}));
    expect(output).toEqual({ error: 'Rule activation requires an active turn.' });
  });
});
