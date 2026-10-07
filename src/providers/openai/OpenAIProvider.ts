import OpenAI from 'openai';
import { z } from 'zod';
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
import type { ChatProviderState } from '../../chat/ChatProviderState.ts';
import type { ChatRequest } from '../../chat/ChatRequest.ts';
import type { ChatContextEvent } from '../../chat/ChatContextEvent.ts';
import { AgentRuntime } from '../../chat/runtime/AgentRuntime.ts';
import type {
  AgentModelAdapter,
  AgentToolResult,
  AgentTurnContext,
  AgentTurnStep,
} from '../../chat/runtime/AgentModelAdapter.ts';

interface OpenAITurn {
  readonly client: OpenAI;
  readonly input: ResponseInputItem[];
}

/** OpenAI Responses protocol adapter hosted by the provider-independent runtime. */
class OpenAIModelAdapter implements AgentModelAdapter<OpenAITurn> {
  constructor(
    readonly model: string,
    private readonly configuration: ChatConfiguration,
    private readonly token: () => Promise<string>,
    private readonly client: OpenAI | undefined,
    private readonly tools: ToolRuntime,
  ) {}

  emptyState(): ChatProviderState {
    return stateFrom([]);
  }

  restoreState(state: ChatProviderState): ChatProviderState {
    return stateFrom(historyFrom(state));
  }

  recoverInterruptedToolCalls(state: ChatProviderState) {
    const history = historyFrom(state);
    const settled = new Set(
      history.flatMap(item =>
        (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && 'call_id' in item
          ? [item.call_id]
          : [],
      ),
    );
    const results: ResponseInputItem[] = [];
    for (const item of history) {
      if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || settled.has(item.call_id)) continue;
      const output = JSON.stringify({
        error: {
          code: 'TOOL_EXECUTION_INTERRUPTED',
          message: 'Glyph restarted before this tool reported an outcome; side effects may have occurred.',
          outcome: 'unknown',
        },
      });
      results.push(
        item.type === 'custom_tool_call'
          ? { type: 'custom_tool_call_output', call_id: item.call_id, output }
          : { type: 'function_call_output', call_id: item.call_id, output },
      );
    }
    return {
      state: results.length === 0 ? stateFrom(history) : stateFrom([...history, ...results]),
      recoveredCallCount: results.length,
    };
  }

  recordContext(state: ChatProviderState, events: readonly ChatContextEvent[]): ChatProviderState {
    const history = historyFrom(state);
    for (const event of events) {
      if (history.some(item => contextEventId(item) === event.id)) continue;
      history.push(toContextEventInput(event));
    }
    return stateFrom(history);
  }

  async beginTurn(state: ChatProviderState, request: ChatRequest, context: AgentTurnContext): Promise<OpenAITurn> {
    const accessToken = await this.token();
    context.trace('authentication.resolved', { accessToken: '[REDACTED]' });
    context.signal.throwIfAborted();
    const client =
      this.client ??
      new OpenAI({
        apiKey: accessToken,
        baseURL: 'https://api.openai.com/v1',
        organization: null,
        project: null,
        maxRetries: 0,
        logLevel: 'off',
      });
    return { client, input: [...historyFrom(state), toUserInput(request)] };
  }

  async streamStep(turn: OpenAITurn, context: AgentTurnContext): Promise<AgentTurnStep<OpenAITurn>> {
    const request = {
      model: this.model,
      instructions: this.configuration.instructions,
      input: turn.input,
      stream: true,
      // Keep state client-side; complete response items are replayed in `input`.
      store: false,
      tools: toOpenAITools(this.tools),
      parallel_tool_calls: false,
      // Reasoning summaries are model-authored explanations, not raw chain of thought.
      reasoning: { summary: 'auto' },
      // Preserve opaque reasoning state for stateless multi-turn reasoning models.
      include: ['reasoning.encrypted_content'],
    } satisfies ResponseCreateParamsStreaming;
    context.trace('request.body', request, context.round);
    const {
      data: stream,
      response: httpResponse,
      request_id: requestId,
    } = await turn.client.responses.create(request, { signal: context.signal }).withResponse();
    context.trace(
      'response.http',
      {
        requestId,
        status: httpResponse.status,
        statusText: httpResponse.statusText,
        headers: responseHeaders(httpResponse.headers),
      },
      context.round,
    );
    let response: Response | undefined;
    const completedOutputItems = new Map<number, ResponseOutputItem>();
    let streamedText = '';
    let reportedReasoningSummary = '';
    const reasoningSummaryParts = new Map<string, string>();
    const reportReasoningSummary = (delta: string): void => {
      if (!delta) return;
      reportedReasoningSummary += delta;
      context.onReasoningSummary?.(delta);
    };
    const beginReasoningSummaryPart = (key: string): void => {
      if (reasoningSummaryParts.has(key)) return;
      if (reasoningSummaryParts.size > 0) reportReasoningSummary('\n\n');
      reasoningSummaryParts.set(key, '');
    };
    const completeReasoningSummaryPart = (key: string, text: string): void => {
      beginReasoningSummaryPart(key);
      const streamedPart = reasoningSummaryParts.get(key) ?? '';
      if (!text.startsWith(streamedPart)) return;
      reasoningSummaryParts.set(key, text);
      reportReasoningSummary(text.slice(streamedPart.length));
    };
    for await (const event of stream) {
      context.trace('response.stream_event', event, context.round);
      switch (event.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          streamedText += event.delta;
          context.onText(event.delta);
          break;
        case 'response.reasoning_summary_text.delta': {
          const key = `${event.item_id}:${event.summary_index}`;
          beginReasoningSummaryPart(key);
          reasoningSummaryParts.set(key, `${reasoningSummaryParts.get(key) ?? ''}${event.delta}`);
          reportReasoningSummary(event.delta);
          break;
        }
        case 'response.reasoning_summary_text.done':
          completeReasoningSummaryPart(`${event.item_id}:${event.summary_index}`, event.text);
          break;
        case 'response.reasoning_summary_part.done':
          completeReasoningSummaryPart(`${event.item_id}:${event.summary_index}`, event.part.text);
          break;
        case 'response.completed':
          response = event.response;
          break;
        case 'response.output_item.done':
          completedOutputItems.set(event.output_index, event.item);
          break;
        case 'response.incomplete':
          throw new ProviderError(
            `Response incomplete (${event.response.incomplete_details?.reason ?? 'unknown'}). Try a shorter request.`,
          );
        case 'response.failed':
          throw new ProviderError(
            `Response failed: ${`${event.response.error?.code ?? 'unknown'}: ${event.response.error?.message ?? 'unknown error'}`}`,
          );
        case 'error':
          throw new ProviderError(`API stream error: ${event.message}`);
      }
    }
    context.signal.throwIfAborted();
    if (!response) throw new ProviderError('Connection ended before the response completed.');

    const output = mergeOutputItems(response.output, completedOutputItems);
    for (const item of output) {
      if (item.type !== 'reasoning') continue;
      item.summary.forEach((part, index) => {
        completeReasoningSummaryPart(`${item.id}:${index}`, part.text);
      });
    }
    const usage = usageFrom(response);
    context.trace(
      'response.completed',
      {
        terminalResponse: response,
        collectedOutput: output,
        usage,
      },
      context.round,
    );
    const nextTurn = { ...turn, input: [...turn.input, ...toResponseInputItems(output)] };
    const calls = output.filter(
      (item): item is ResponseFunctionToolCall | ResponseCustomToolCall =>
        item.type === 'function_call' || item.type === 'custom_tool_call',
    );
    const completedText = visibleTextFrom(output);
    const completedReasoningSummary = reasoningSummaryFrom(output);
    context.trace(
      'response.interpreted',
      {
        terminalOutputTypes: response.output.map(item => item.type),
        collectedOutputTypes: output.map(item => item.type),
        streamedText,
        completedText,
        reportedReasoningSummary,
        completedReasoningSummary,
        toolCalls: calls,
      },
      context.round,
    );
    // Completed output items are authoritative. Some routes omit text deltas.
    if (completedText.startsWith(streamedText)) {
      const missingText = completedText.slice(streamedText.length);
      if (missingText) context.onText(missingText);
    }
    return {
      turn: nextTurn,
      responseId: response.id,
      usage,
      hasVisibleOutput: Boolean(streamedText.trim() || completedText.trim()),
      toolCalls: calls.map(call => ({
        id: call.call_id,
        ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
        name: call.name,
        input: call.type === 'function_call' ? call.arguments : call.input,
        protocolData: call.type,
      })),
    };
  }

  appendToolResults(turn: OpenAITurn, results: readonly AgentToolResult[]): OpenAITurn {
    const outputs: ResponseInputItem[] = results.map(result =>
      result.call.protocolData === 'custom_tool_call'
        ? { type: 'custom_tool_call_output', call_id: result.call.id, output: result.output }
        : { type: 'function_call_output', call_id: result.call.id, output: result.output },
    );
    return { ...turn, input: [...turn.input, ...outputs] };
  }

  commit(turn: OpenAITurn): ChatProviderState {
    return stateFrom(turn.input);
  }
}

/** Compatibility entry point for the currently configured OpenAI backend. */
export class OpenAIProvider extends AgentRuntime<OpenAITurn> {
  constructor(
    model: string,
    configuration: ChatConfiguration,
    token: () => Promise<string>,
    client: OpenAI | undefined,
    tools: ToolRuntime,
    initialState?: ChatProviderState,
  ) {
    super(new OpenAIModelAdapter(model, configuration, token, client, tools), configuration, tools, initialState);
  }
}

const openAIProviderStateSchema = z
  .object({
    provider: z.literal('openai-responses'),
    version: z.literal(1),
    data: z.object({ history: z.array(z.record(z.string(), z.unknown())) }).strict(),
  })
  .strict();

function stateFrom(history: readonly ResponseInputItem[]): ChatProviderState {
  return {
    provider: 'openai-responses',
    version: 1,
    data: structuredClone({ history }),
  };
}

function historyFrom(state: ChatProviderState): ResponseInputItem[] {
  const parsed = openAIProviderStateSchema.safeParse(state);
  if (!parsed.success) throw new ProviderError('Saved conversation state is not compatible with OpenAI Responses.');
  return structuredClone(parsed.data.data.history) as unknown as ResponseInputItem[];
}

function toUserInput(request: ChatRequest): ResponseInputItem {
  if (request.attachments.length === 0) return { role: 'user', content: request.text };
  const context = JSON.stringify({
    schema: 'glyph.workspace-context.v1',
    files: request.attachments.map(attachment => ({
      path: attachment.path,
      revision: attachment.revision,
      byteOrderMark: attachment.byteOrderMark,
      text: attachment.text,
    })),
  });
  return {
    role: 'user',
    content: [
      { type: 'input_text', text: context },
      { type: 'input_text', text: request.text },
    ],
  };
}

function toContextEventInput(event: ChatContextEvent): ResponseInputItem {
  return {
    role: event.type === 'shell_wake' ? 'user' : 'developer',
    content: JSON.stringify({ schema: 'glyph.context-event.v1', event }),
  };
}

function contextEventId(item: ResponseInputItem): string | undefined {
  if (
    (item.type !== undefined && item.type !== 'message') ||
    !('role' in item) ||
    (item.role !== 'developer' && item.role !== 'user') ||
    !('content' in item) ||
    typeof item.content !== 'string'
  )
    return undefined;
  try {
    const value = JSON.parse(item.content) as {
      schema?: unknown;
      event?: { id?: unknown; type?: unknown };
    };
    if (value.schema !== 'glyph.context-event.v1' || typeof value.event?.id !== 'string') return undefined;
    if (item.role === 'user' && value.event.type !== 'shell_wake') return undefined;
    return value.event.id;
  } catch {
    return undefined;
  }
}

function responseHeaders(headers: Headers): Record<string, string> {
  const sensitive = new Set(['authorization', 'proxy-authenticate', 'set-cookie', 'www-authenticate']);
  return Object.fromEntries(
    [...headers].map(([name, value]) => [name, sensitive.has(name.toLowerCase()) ? '[REDACTED]' : value]),
  );
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
  return output
    .flatMap(item =>
      item.type === 'message' ? item.content.map(part => (part.type === 'output_text' ? part.text : part.refusal)) : [],
    )
    .join('');
}

function reasoningSummaryFrom(output: ResponseOutputItem[]): string {
  return output.flatMap(item => (item.type === 'reasoning' ? item.summary.map(part => part.text) : [])).join('\n\n');
}

function usageFrom(response: Response): AgentTurnStep<OpenAITurn>['usage'] {
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
    namespace.tools.push(
      definition.inputKind === ToolInputKind.TEXT
        ? { type: 'custom', name: definition.name, description: definition.description }
        : {
            type: 'function',
            name: definition.name,
            description: definition.description,
            strict: true,
            parameters: definition.parameters ?? {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false,
            },
          },
    );
  }
  return [...namespaces.values()];
}
