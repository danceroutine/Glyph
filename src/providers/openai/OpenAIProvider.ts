import OpenAI from 'openai';
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems';
import type {
  Response,
  ResponseCreateParamsStreaming,
  ResponseCustomToolCall,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputItem,
  NamespaceTool,
} from 'openai/resources/responses/responses';
import type { ChatConfiguration } from '../../configuration/ChatConfiguration.ts';
import { ProviderError } from '../../errors/ProviderError.ts';
import type { ToolRuntime } from '../../tools/ToolRuntime.ts';
import { ToolInputKind } from '../../tools/ToolInputKind.ts';
import type { ChatProvider } from '../../chat/ChatProvider.ts';
import type { ProviderTraceEntry } from '../../chat/ProviderTraceEntry.ts';
import type { ToolActivity } from '../../chat/ToolActivity.ts';
import { ToolActivityPhase } from '../../chat/ToolActivityPhase.ts';
import type { TurnResult } from '../../chat/TurnResult.ts';

const MAX_TOOL_ROUNDS = 8;
export class OpenAIProvider implements ChatProvider {
  private history: ResponseInputItem[] = [];
  private busy = false;

  constructor(
    private readonly modelName: string,
    private readonly configuration: ChatConfiguration,
    private readonly token: () => Promise<string>,
    private readonly client: OpenAI | undefined,
    private readonly tools: ToolRuntime,
  ) {}

  get model(): string { return this.modelName; }

  reset(): void {
    if (this.busy) throw new ProviderError('Cannot reset during a response. Cancel it first.');
    this.history = [];
  }

  async send(text: string, options: {
    signal: AbortSignal;
    onText: (delta: string) => void;
    onTrace?: (entry: ProviderTraceEntry) => void;
    onToolActivity?: (activity: ToolActivity) => void;
  }): Promise<TurnResult> {
    if (this.busy) throw new ProviderError('A response is already in progress.');
    if (!text.trim()) throw new ProviderError('Message cannot be empty.');
    this.busy = true;
    const timeout = AbortSignal.timeout(this.configuration.timeoutMs);
    const signal = AbortSignal.any([options.signal, timeout]);
    let input: ResponseInputItem[] = [...this.history, { role: 'user', content: text }];
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
    trace('turn.started', {
      model: this.model,
      timeoutMs: this.configuration.timeoutMs,
      committedHistory: this.history,
      userInput: text,
    });
    try {
      const accessToken = await this.token();
      trace('authentication.resolved', { accessToken: '[REDACTED]' });
      signal.throwIfAborted();
      const client = this.client ?? new OpenAI({
        apiKey: accessToken,
        baseURL: 'https://api.openai.com/v1',
        organization: null,
        project: null,
        maxRetries: 0,
        logLevel: 'off',
      });
      let totalUsage: TurnResult['usage'] = null;
      let toolRounds = 0;

      for (;;) {
        const round = toolRounds + 1;
        const request = {
          model: this.model,
          instructions: this.configuration.instructions,
          input,
          stream: true,
          // Keep state client-side; complete response items are replayed in `input`.
          store: false,
          tools: toOpenAITools(this.tools),
          parallel_tool_calls: false,
          // Preserve opaque reasoning state for stateless multi-turn reasoning models.
          include: ['reasoning.encrypted_content'],
        } satisfies ResponseCreateParamsStreaming;
        trace('request.body', request, round);
        const {
          data: stream,
          response: httpResponse,
          request_id: requestId,
        } = await client.responses.create(request, { signal }).withResponse();
        trace('response.http', {
          requestId,
          status: httpResponse.status,
          statusText: httpResponse.statusText,
          headers: responseHeaders(httpResponse.headers),
        }, round);
        let response: Response | undefined;
        const completedOutputItems = new Map<number, ResponseOutputItem>();
        let streamedText = '';
        for await (const event of stream) {
          trace('response.stream_event', event, round);
          switch (event.type) {
            case 'response.output_text.delta':
            case 'response.refusal.delta':
              streamedText += event.delta;
              options.onText(event.delta);
              break;
            case 'response.completed':
              response = event.response;
              break;
            case 'response.output_item.done':
              completedOutputItems.set(event.output_index, event.item);
              break;
            case 'response.incomplete':
              throw new ProviderError(`Response incomplete (${event.response.incomplete_details?.reason ?? 'unknown'}). Try a shorter request.`);
            case 'response.failed':
              throw new ProviderError(`Response failed: ${`${event.response.error?.code ?? 'unknown'}: ${event.response.error?.message ?? 'unknown error'}`}`);
            case 'error':
              throw new ProviderError(`API stream error: ${event.message}`);
          }
        }
        signal.throwIfAborted();
        if (!response) throw new ProviderError('Connection ended before the response completed.');

        totalUsage = addUsage(totalUsage, usageFrom(response));
        const output = mergeOutputItems(response.output, completedOutputItems);
        trace('response.completed', {
          terminalResponse: response,
          collectedOutput: output,
          accumulatedUsage: totalUsage,
        }, round);
        input = [...input, ...toResponseInputItems(output)];
        const calls = output.filter((item): item is ResponseFunctionToolCall | ResponseCustomToolCall =>
          item.type === 'function_call' || item.type === 'custom_tool_call');
        const completedText = visibleTextFrom(output);
        trace('response.interpreted', {
          terminalOutputTypes: response.output.map(item => item.type),
          collectedOutputTypes: output.map(item => item.type),
          streamedText,
          completedText,
          toolCalls: calls,
        }, round);
        // Completed output items are authoritative. Some routes omit text
        // deltas even though the finished message item has visible content.
        if (completedText.startsWith(streamedText)) {
          const missingText = completedText.slice(streamedText.length);
          if (missingText) options.onText(missingText);
        }
        if (calls.length === 0) {
          if (!streamedText.trim() && !completedText.trim()) {
            throw new ProviderError(`The model completed without returning text or a project tool call. Response ID: ${response.id}`);
          }
          // Only commit a complete turn. Failures/cancellation leave prior context intact.
          this.history = input;
          trace('history.committed', { history: this.history }, round);
          return { responseId: response.id, usage: totalUsage };
        }
        toolRounds += 1;
        if (toolRounds > MAX_TOOL_ROUNDS) throw new ProviderError(`Stopped after ${MAX_TOOL_ROUNDS} project tool rounds.`);

        const outputs = await Promise.all(calls.map(async call => {
          trace('tool.call', { call }, round);
          const input = call.type === 'function_call' ? call.arguments : call.input;
          const activity = {
            ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
            name: call.name,
            callId: call.call_id,
            arguments: input,
          };
          reportToolActivity({ phase: ToolActivityPhase.STARTED, ...activity });
          const output = await this.tools.execute(call.name, input);
          trace('tool.result', {
            namespace: call.namespace,
            name: call.name,
            callId: call.call_id,
            output,
          }, round);
          reportToolActivity({ phase: ToolActivityPhase.COMPLETED, ...activity, output });
          return call.type === 'function_call'
            ? { type: 'function_call_output' as const, call_id: call.call_id, output }
            : { type: 'custom_tool_call_output' as const, call_id: call.call_id, output };
        }));
        input = [...input, ...outputs];
      }
    } catch (error) {
      const reportedError = options.signal.aborted
        ? new ProviderError('Response cancelled.', { cause: error })
        : timeout.aborted
          ? new ProviderError(`Response timed out after ${this.configuration.timeoutMs} ms.`, { cause: error })
          : error instanceof ProviderError
            ? error
            : new ProviderError(error instanceof Error ? error.message : 'ChatGPT provider failed.', { cause: error });
      trace('history.rolled_back', {
        committedHistory: this.history,
        discardedInput: input,
      });
      trace('turn.failed', errorDetails(reportedError));
      throw reportedError;
    } finally {
      this.busy = false;
    }
  }
}

function responseHeaders(headers: Headers): Record<string, string> {
  const sensitive = new Set(['authorization', 'proxy-authenticate', 'set-cookie', 'www-authenticate']);
  return Object.fromEntries([...headers].map(([name, value]) => [
    name,
    sensitive.has(name.toLowerCase()) ? '[REDACTED]' : value,
  ]));
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
    details[name] = value instanceof Error
      ? errorDetails(value)
      : value instanceof Headers
        ? responseHeaders(value)
        : value;
  }
  return details;
}

function mergeOutputItems(
  terminalOutput: ResponseOutputItem[],
  streamedOutput: ReadonlyMap<number, ResponseOutputItem>,
): ResponseOutputItem[] {
  const byIndex = new Map(terminalOutput.map((item, index) => [index, item]));
  for (const [index, item] of streamedOutput) byIndex.set(index, item);
  return [...byIndex.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
}

function visibleTextFrom(output: ResponseOutputItem[]): string {
  return output.flatMap(item => item.type === 'message'
    ? item.content.map(part => part.type === 'output_text' ? part.text : part.refusal)
    : []).join('');
}

function usageFrom(response: Response): TurnResult['usage'] {
  if (!response.usage) return null;
  const {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedInputTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: totalTokens,
  } = response.usage;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens };
}

function addUsage(left: TurnResult['usage'], right: TurnResult['usage']): TurnResult['usage'] {
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

function toOpenAITools(runtime: ToolRuntime): NamespaceTool[] {
  const namespaces = new Map<string, NamespaceTool>();
  for (const definition of runtime.definitions) {
    let namespace = namespaces.get(definition.namespace);
    if (!namespace) {
      namespace = {
        type: 'namespace',
        name: definition.namespace,
        description: `${definition.namespace} tools supplied by the host runtime.`,
        tools: [],
      };
      namespaces.set(definition.namespace, namespace);
    }
    namespace.tools.push(definition.inputKind === ToolInputKind.TEXT
      ? { type: 'custom', name: definition.name, description: definition.description }
      : {
        type: 'function',
        name: definition.name,
        description: definition.description,
        strict: true,
        parameters: definition.parameters ?? { type: 'object', properties: {}, required: [], additionalProperties: false },
      });
  }
  return [...namespaces.values()];
}
