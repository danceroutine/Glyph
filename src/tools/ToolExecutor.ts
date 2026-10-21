import { randomUUID } from 'node:crypto';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import type { ToolActivity } from '#src/chat/ToolActivity.js';
import type { AgentToolCall } from '#src/chat/runtime/AgentModelAdapter.js';
import type { AgentModeID } from '#src/chat/AgentMode.js';
import type { ToolExecutionContext } from './ToolExecutionContext.ts';
import type { ToolRegistry } from './ToolRegistry.ts';

interface ToolExecutionOptions {
  readonly signal: AbortSignal;
  readonly context: ToolExecutionContext & { readonly mode: AgentModeID };
  readonly roundCallCount: number;
  readonly onActivity: (activity: ToolActivity) => void;
  readonly trace: (kind: string, data: unknown) => void;
}

/** Mandatory invocation boundary; domain services retain their resource-specific approvals and validation. */
export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(
    call: AgentToolCall,
    options: ToolExecutionOptions,
  ): Promise<{ output: string; interruption?: unknown }> {
    const activity = {
      ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
      name: call.name,
      callId: call.id,
      executionId: randomUUID(),
      arguments: call.input,
    };
    options.trace('tool.call', { call });
    options.onActivity({ phase: ToolActivityPhase.STARTED, ...activity });
    const result = await this.invoke(call, options, activity.executionId);
    options.trace('tool.result', {
      namespace: call.namespace,
      name: call.name,
      callId: call.id,
      output: result.output,
    });
    options.onActivity({ phase: result.phase, ...activity, output: result.output });
    return result;
  }

  private async invoke(
    call: AgentToolCall,
    options: ToolExecutionOptions,
    executionId: string,
  ): Promise<{
    output: string;
    phase: ToolActivityPhase;
    interruption?: unknown;
  }> {
    const { signal, context } = options;
    let started = false;
    try {
      signal.throwIfAborted();
      const tool = this.registry.resolve(call);
      if (!tool.allowedModes.includes(context.mode))
        return {
          phase: ToolActivityPhase.FAILED,
          output: failure(
            'TOOL_MODE_DENIED',
            `Tool ${tool.namespace}.${tool.name} is unavailable in ${context.mode} mode. Request an approved mode switch before using it.`,
            false,
          ),
        };
      if (tool.requiresExclusiveRound && options.roundCallCount !== 1)
        return {
          phase: ToolActivityPhase.FAILED,
          output: failure(
            'TOOL_REQUIRES_EXCLUSIVE_ROUND',
            'This tool must be called alone, without other tool calls in the same round.',
            false,
          ),
        };
      try {
        tool.validateInput(call.input);
      } catch (error) {
        return {
          phase: ToolActivityPhase.FAILED,
          output: failure('MALFORMED', error instanceof Error ? error.message : 'Invalid tool input.', false),
        };
      }
      signal.throwIfAborted();
      started = true;
      const output = await tool.execute(call.input, signal, { ...context, executionId });
      // A service may finish persisting an admitted mutation after cancellation.
      // Keep its settled receipt in history, but never resume the cancelled turn.
      if (signal.aborted) return { phase: ToolActivityPhase.INTERRUPTED, output, interruption: signal.reason };
      return { phase: ToolActivityPhase.COMPLETED, output };
    } catch (error) {
      const phase = signal.aborted ? ToolActivityPhase.INTERRUPTED : ToolActivityPhase.FAILED;
      const code = !started
        ? 'TOOL_NOT_STARTED'
        : signal.aborted
          ? 'TOOL_EXECUTION_INTERRUPTED'
          : 'TOOL_EXECUTION_FAILED';
      const message = started
        ? signal.aborted
          ? 'The call was interrupted; it may have produced side effects before cancellation.'
          : 'The tool threw before reporting an outcome; side effects may have occurred.'
        : error instanceof Error
          ? error.message
          : 'The call was not started.';
      return {
        phase,
        output: failure(code, message, started),
        ...(signal.aborted ? { interruption: signal.reason ?? error } : {}),
      };
    }
  }
}

function failure(code: string, message: string, unknown: boolean): string {
  return JSON.stringify({ error: { code, message, outcome: unknown ? 'unknown' : 'not_started' } });
}
