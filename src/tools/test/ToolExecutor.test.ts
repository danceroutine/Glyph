import type { ToolActivity } from '#src/chat/ToolActivity.js';
import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import { ToolInputKind } from '#src/tools/ToolInputKind.js';
import { ToolRegistry } from '#src/tools/ToolRegistry.js';
import { ToolExecutor } from '#src/tools/ToolExecutor.js';
import type { Tool } from '#src/tools/Tool.js';

type ToolErrorOutput = { error: { code: string; outcome: string; message?: string } };

const call = { id: 'call', namespace: 'example', name: 'new_capability', input: '{}' };
function fixture(allowedModes: Tool['allowedModes'] = [AgentModeID.AGENT]) {
  const tool = {
    namespace: call.namespace,
    name: call.name,
    description: 'New capability',
    inputKind: ToolInputKind.JSON,
    allowedModes,
    validateInput: vi.fn((input: string) => {
      JSON.parse(input);
    }),
    execute: vi.fn<Tool['execute']>(async () => 'done'),
  };
  const controller = new AbortController();
  const executor = new ToolExecutor(new ToolRegistry([tool]));
  const options = {
    signal: controller.signal,
    context: { mode: AgentModeID.PLAN },
    roundCallCount: 1,
    onActivity: vi.fn((_activity: ToolActivity) => undefined),
    trace: vi.fn(),
  };
  return { tool, controller, executor, options };
}
describe(ToolExecutor, () => {
  it('denies unsupported modes before validation or execution, ignoring model-supplied mode text', async () => {
    const f = fixture();
    const result = await f.executor.execute({ ...call, input: '{"mode":"agent"}' }, f.options);
    expect((JSON.parse(result.output) as ToolErrorOutput).error).toMatchObject({
      code: 'TOOL_MODE_DENIED',
      outcome: 'not_started',
    });
    expect(f.tool.validateInput).not.toHaveBeenCalled();
    expect(f.tool.execute).not.toHaveBeenCalled();
  });
  it('permits a newly registered Plan tool without a central name list', async () => {
    const f = fixture([AgentModeID.PLAN]);
    expect(await f.executor.execute(call, f.options)).toMatchObject({ output: 'done' });
    expect(f.tool.execute).toHaveBeenCalledWith(
      '{}',
      f.controller.signal,
      expect.objectContaining({ mode: AgentModeID.PLAN, executionId: expect.any(String) }),
    );
    expect(f.options.onActivity.mock.calls.map(([event]) => event.phase)).toEqual([
      ToolActivityPhase.STARTED,
      ToolActivityPhase.COMPLETED,
    ]);
  });
  it('rejects namespace substitution and unknown tools without invoking another handler', async () => {
    const f = fixture([AgentModeID.PLAN]);
    for (const invalid of [
      { ...call, namespace: 'other' },
      { ...call, name: 'absent' },
    ]) {
      const result = await f.executor.execute(invalid, f.options);
      expect((JSON.parse(result.output) as ToolErrorOutput).error.outcome).toBe('not_started');
    }
    expect(f.tool.execute).not.toHaveBeenCalled();
  });
  it('enforces exclusive-round declarations without special-casing tool names', async () => {
    const f = fixture([AgentModeID.PLAN]);
    const executor = new ToolExecutor(new ToolRegistry([{ ...f.tool, requiresExclusiveRound: true }]));
    const result = await executor.execute(call, { ...f.options, roundCallCount: 2 });
    expect((JSON.parse(result.output) as ToolErrorOutput).error.code).toBe('TOOL_REQUIRES_EXCLUSIVE_ROUND');
    expect(f.tool.execute).not.toHaveBeenCalled();
  });
  it('validates before effects and records malformed arguments as not started', async () => {
    const f = fixture([AgentModeID.PLAN]);
    const result = await f.executor.execute({ ...call, input: 'invalid' }, f.options);
    expect((JSON.parse(result.output) as ToolErrorOutput).error).toMatchObject({
      code: 'MALFORMED',
      outcome: 'not_started',
    });
    expect(f.tool.execute).not.toHaveBeenCalled();
  });
  it.each(['before', 'after validation'])('honors cancellation %s without starting the tool', async stage => {
    const f = fixture([AgentModeID.PLAN]);
    if (stage === 'before') f.controller.abort(new Error('Stopped'));
    else
      f.tool.validateInput.mockImplementation(() => {
        f.controller.abort(new Error('Stopped'));
      });
    const result = await f.executor.execute(call, f.options);
    expect((JSON.parse(result.output) as ToolErrorOutput).error.outcome).toBe('not_started');
    expect(result.interruption).toBeInstanceOf(Error);
    expect(f.tool.execute).not.toHaveBeenCalled();
  });
  it('preserves a settled receipt after cancellation without marking the call successful or retrying', async () => {
    const f = fixture([AgentModeID.PLAN]);
    f.tool.execute.mockImplementation(async () => {
      f.controller.abort(new Error('Stopped'));
      return 'durable mutation receipt';
    });
    const result = await f.executor.execute(call, f.options);
    expect(result.output).toBe('durable mutation receipt');
    expect(result.interruption).toBe(f.controller.signal.reason);
    expect(f.tool.execute).toHaveBeenCalledTimes(1);
    expect(f.options.onActivity.mock.calls.at(-1)?.[0].phase).toBe(ToolActivityPhase.INTERRUPTED);
  });
  it('retains an unknown outcome after an execution failure instead of claiming no effects occurred', async () => {
    const f = fixture([AgentModeID.PLAN]);
    f.tool.execute.mockRejectedValue(new Error('Failed after an effect'));
    const result = await f.executor.execute(call, f.options);
    expect((JSON.parse(result.output) as ToolErrorOutput).error).toMatchObject({
      code: 'TOOL_EXECUTION_FAILED',
      outcome: 'unknown',
    });
  });

  describe(ToolExecutor.prototype.execute, () => {
    it('reports a generic malformed-input message when validation fails with a non-error value', async () => {
      const f = fixture([AgentModeID.PLAN]);
      f.tool.validateInput.mockImplementation(() => {
        throw 'bad input';
      });

      const result = await f.executor.execute(call, f.options);

      expect((JSON.parse(result.output) as ToolErrorOutput).error).toEqual({
        code: 'MALFORMED',
        message: 'Invalid tool input.',
        outcome: 'not_started',
      });
    });

    it('reports a generic not-started message when cancelled with a non-error reason', async () => {
      const f = fixture([AgentModeID.PLAN]);
      f.controller.abort('stopped');

      const result = await f.executor.execute(call, f.options);

      expect((JSON.parse(result.output) as ToolErrorOutput).error).toEqual({
        code: 'TOOL_NOT_STARTED',
        message: 'The call was not started.',
        outcome: 'not_started',
      });
      expect(result.interruption).toBe('stopped');
    });

    it('reports the thrown failure as the interruption when cancellation carries no reason', async () => {
      const f = fixture([AgentModeID.PLAN]);
      const signal = { aborted: false, reason: undefined, throwIfAborted: () => {} };
      const failure = new Error('Interrupted mid-flight');
      f.tool.execute.mockImplementation(async () => {
        signal.aborted = true;
        throw failure;
      });

      const result = await f.executor.execute(call, { ...f.options, signal: signal as unknown as AbortSignal });

      expect((JSON.parse(result.output) as ToolErrorOutput).error).toEqual({
        code: 'TOOL_EXECUTION_INTERRUPTED',
        message: 'The call was interrupted; it may have produced side effects before cancellation.',
        outcome: 'unknown',
      });
      expect(result.interruption).toBe(failure);
    });
  });
});
