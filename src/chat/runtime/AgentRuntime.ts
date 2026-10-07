import { ProviderError } from '../../errors/ProviderError.ts';
import type { ToolRuntime } from '../../tools/ToolRuntime.ts';
import type { ChatContextEvent } from '../ChatContextEvent.ts';
import type { ChatProvider } from '../ChatProvider.ts';
import type { ChatProviderState } from '../ChatProviderState.ts';
import type { ProviderTraceEntry } from '../ProviderTraceEntry.ts';
import type { ChatRequestInput } from '../ChatRequest.ts';
import { toChatRequest } from '../ChatRequest.ts';
import type { ToolActivity } from '../ToolActivity.ts';
import { ToolActivityPhase } from '../ToolActivityPhase.ts';
import type { TurnResult } from '../TurnResult.ts';
import type { Usage } from '../Usage.ts';
import type { AgentModelAdapter, AgentToolResult, AgentTurnContext } from './AgentModelAdapter.ts';
import type { ToolExecutionContext } from '../../tools/ToolExecutionContext.ts';

interface AgentRuntimeConfiguration {
  readonly timeoutMs: number;
}

/** Provider-independent turn lifecycle, tool loop, cancellation, and state transaction. */
export class AgentRuntime<TTurn> implements ChatProvider {
  private state: ChatProviderState;
  private busy = false;

  constructor(
    private readonly adapter: AgentModelAdapter<TTurn>,
    private readonly configuration: AgentRuntimeConfiguration,
    private readonly tools: ToolRuntime,
    initialState?: ChatProviderState,
  ) {
    this.state = initialState ? adapter.restoreState(initialState) : adapter.emptyState();
  }

  get model(): string {
    return this.adapter.model;
  }

  recordContext(events: readonly ChatContextEvent[]): void {
    if (this.busy) throw new ProviderError('Cannot record context during a response. Cancel it first.');
    this.state = this.adapter.recordContext(this.state, events);
  }

  exportState(): ChatProviderState {
    return structuredClone(this.state);
  }

  restoreState(state: ChatProviderState): void {
    if (this.busy) throw new ProviderError('Cannot restore history during a response. Cancel it first.');
    this.state = this.adapter.restoreState(state);
  }

  reset(): void {
    if (this.busy) throw new ProviderError('Cannot reset during a response. Cancel it first.');
    this.state = this.adapter.emptyState();
  }

  async send(
    inputRequest: ChatRequestInput,
    options: {
      signal: AbortSignal;
      onText: (delta: string) => void;
      onReasoningSummary?: (delta: string) => void;
      onTrace?: (entry: ProviderTraceEntry) => void;
      onToolActivity?: (activity: ToolActivity) => void;
      onStateCheckpoint?: (state: ChatProviderState) => void | Promise<void>;
      toolContext?: ToolExecutionContext;
    },
  ): Promise<TurnResult> {
    const request = toChatRequest(inputRequest);
    if (this.busy) throw new ProviderError('A response is already in progress.');
    if (!request.text.trim()) throw new ProviderError('Message cannot be empty.');
    this.busy = true;
    const timeout = AbortSignal.timeout(this.configuration.timeoutMs);
    const signal = AbortSignal.any([options.signal, timeout]);
    let traceSequence = 0;
    const trace = (kind: string, data: unknown, round?: number): void => {
      try {
        options.onTrace?.({
          sequence: ++traceSequence,
          timestamp: new Date().toISOString(),
          kind,
          ...(round === undefined ? {} : { round }),
          data,
        });
      } catch {
        // Diagnostics must never alter inference behavior.
      }
    };
    const reportToolActivity = (activity: ToolActivity): void => {
      try {
        options.onToolActivity?.(activity);
      } catch {
        // Rendering activity must never alter tool execution.
      }
    };
    const context = (round: number): AgentTurnContext => ({
      signal,
      round,
      onText: options.onText,
      ...(options.onReasoningSummary ? { onReasoningSummary: options.onReasoningSummary } : {}),
      trace,
    });
    trace('turn.started', {
      model: this.model,
      timeoutMs: this.configuration.timeoutMs,
      committedState: this.state,
      userInput: {
        text: request.text,
        attachments: request.attachments.map(attachment => ({
          path: attachment.path,
          revision: attachment.revision,
          byteLength: attachment.byteLength,
          byteOrderMark: attachment.byteOrderMark,
        })),
      },
    });
    let turn: TTurn | undefined;
    let hasToolCheckpoint = false;
    try {
      const recovery = this.adapter.recoverInterruptedToolCalls(this.state);
      if (recovery.recoveredCallCount > 0) {
        this.state = recovery.state;
        hasToolCheckpoint = true;
        await options.onStateCheckpoint?.(structuredClone(this.state));
        trace('tool.interrupted_recovered', { recoveredCallCount: recovery.recoveredCallCount });
      }
      turn = await this.adapter.beginTurn(this.state, request, context(0));
      let totalUsage: Usage | null = null;
      let round = 0;
      for (;;) {
        round += 1;
        const step = await this.adapter.streamStep(turn, context(round));
        turn = step.turn;
        totalUsage = addUsage(totalUsage, step.usage);
        if (step.toolCalls.length === 0) {
          if (!step.hasVisibleOutput) {
            throw new ProviderError(
              `The model completed without returning text or a tool call. Response ID: ${step.responseId}`,
            );
          }
          this.state = this.adapter.commit(turn);
          trace('history.committed', { state: this.state }, round);
          return { responseId: step.responseId, usage: totalUsage };
        }
        this.state = this.adapter.commit(turn);
        hasToolCheckpoint = true;
        await options.onStateCheckpoint?.(structuredClone(this.state));
        trace('tool.intent_checkpointed', { calls: step.toolCalls }, round);

        let interrupted: unknown = signal.aborted ? signal.reason : undefined;
        const results = signal.aborted
          ? step.toolCalls.map(call => ({
              call,
              output: toolInterruptionOutput(
                'TOOL_NOT_STARTED',
                'The call was not started because the turn was cancelled.',
                false,
              ),
            }))
          : await Promise.all(
              step.toolCalls.map(async call => {
                const activity = {
                  ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
                  name: call.name,
                  callId: call.id,
                  arguments: call.input,
                };
                trace('tool.call', { call }, round);
                reportToolActivity({ phase: ToolActivityPhase.STARTED, ...activity });
                let output: string;
                try {
                  output = options.toolContext
                    ? await this.tools.execute(call.name, call.input, signal, options.toolContext)
                    : await this.tools.execute(call.name, call.input, signal);
                } catch (error) {
                  output = toolInterruptionOutput(
                    signal.aborted ? 'TOOL_EXECUTION_INTERRUPTED' : 'TOOL_EXECUTION_FAILED',
                    signal.aborted
                      ? 'The call was interrupted; it may have produced side effects before cancellation.'
                      : 'The tool threw before reporting an outcome; side effects may have occurred.',
                    true,
                  );
                  if (signal.aborted) interrupted ??= error;
                }
                trace('tool.result', { namespace: call.namespace, name: call.name, callId: call.id, output }, round);
                reportToolActivity({ phase: ToolActivityPhase.COMPLETED, ...activity, output });
                return { call, output } satisfies AgentToolResult;
              }),
            );
        interrupted ??= signal.aborted ? signal.reason : undefined;
        turn = this.adapter.appendToolResults(turn, results);
        this.state = this.adapter.commit(turn);
        await options.onStateCheckpoint?.(structuredClone(this.state));
        trace('tool.outcomes_checkpointed', { callIds: results.map(result => result.call.id) }, round);
        if (interrupted !== undefined) throw interrupted;
      }
    } catch (error) {
      const reportedError = options.signal.aborted
        ? new ProviderError('Response cancelled.', { cause: error })
        : timeout.aborted
          ? new ProviderError(`Response timed out after ${this.configuration.timeoutMs} ms.`, { cause: error })
          : error instanceof ProviderError
            ? error
            : new ProviderError(error instanceof Error ? error.message : 'Model provider failed.', { cause: error });
      trace(hasToolCheckpoint ? 'history.preserved_after_tool' : 'history.rolled_back', {
        committedState: this.state,
        hadUncommittedTurn: turn !== undefined,
      });
      trace('turn.failed', errorDetails(reportedError));
      throw reportedError;
    } finally {
      this.busy = false;
    }
  }
}

function toolInterruptionOutput(code: string, message: string, outcomeUnknown: boolean): string {
  return JSON.stringify({
    error: {
      code,
      message,
      outcome: outcomeUnknown ? 'unknown' : 'not_started',
    },
  });
}

function addUsage(left: Usage | null, right: Usage | null): Usage | null {
  if (!left) return right;
  if (!right) return left;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function errorDetails(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  for (const name of Object.getOwnPropertyNames(error)) {
    if (name === 'name' || name === 'message' || name === 'stack') continue;
    const value: unknown = (error as unknown as Record<string, unknown>)[name];
    details[name] =
      value instanceof Error ? errorDetails(value) : value instanceof Headers ? redactedHeaders(value) : value;
  }
  return details;
}

function redactedHeaders(headers: Headers): Record<string, string> {
  const sensitive = new Set(['authorization', 'proxy-authenticate', 'set-cookie', 'www-authenticate']);
  return Object.fromEntries(
    [...headers].map(([name, value]) => [name, sensitive.has(name.toLowerCase()) ? '[REDACTED]' : value]),
  );
}
