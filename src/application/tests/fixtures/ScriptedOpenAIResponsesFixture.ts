import type {
  Response as OpenAIResponse,
  ResponseOutputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { ScriptedResponseRound } from './ScriptedResponseRound.ts';
import type { ScriptedToolInvocation } from './ScriptedToolInvocation.ts';
import { ToolInputKind } from '../../../tools/ToolInputKind.ts';

export class ScriptedOpenAIResponsesFixture {
  readonly requests: Record<string, unknown>[] = [];
  private index = 0;
  private previousCalls: ResponseOutputItem[] = [];

  constructor(private readonly rounds: readonly ScriptedResponseRound[]) {}

  static encodeToolCall(invocation: ScriptedToolInvocation): ResponseOutputItem {
    return invocation.inputKind === ToolInputKind.TEXT
      ? {
        type: 'custom_tool_call', id: `item-${invocation.callId}`, call_id: invocation.callId,
        namespace: invocation.namespace, name: invocation.name, input: String(invocation.input),
      } satisfies ResponseOutputItem
      : {
        type: 'function_call', id: `item-${invocation.callId}`, call_id: invocation.callId, status: 'completed',
        namespace: invocation.namespace, name: invocation.name, arguments: JSON.stringify(invocation.input),
      } satisfies ResponseOutputItem;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<globalThis.Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== 'https://responses.fixture.invalid/v1/responses') throw new Error(`Unexpected fixture URL: ${url}`);
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    this.requests.push(request);
    const round = this.rounds[this.index++];
    if (!round) throw new Error('Unexpected extra Responses request.');
    round.validate?.(request);
    if (this.previousCalls.length > 0) validateContinuation(request, this.previousCalls);
    this.previousCalls = round.output.filter(item => item.type === 'function_call' || item.type === 'custom_tool_call');
    if (round.status === 'cancelled') return cancelledSse(init?.signal ?? undefined);
    const response = makeResponse(round);
    const event = round.status === 'failed'
      ? ({ type: 'response.failed', sequence_number: 1, response } satisfies ResponseStreamEvent)
      : ({ type: 'response.completed', sequence_number: 1, response } satisfies ResponseStreamEvent);
    return sse([event]);
  };

  assertConsumed(): void {
    if (this.index !== this.rounds.length) throw new Error(`Only ${this.index}/${this.rounds.length} scripted Responses rounds were consumed.`);
  }
}

function makeResponse(round: ScriptedResponseRound): OpenAIResponse {
  const failed = round.status === 'failed';
  return {
    id: round.id,
    created_at: 0,
    output_text: '',
    error: failed ? { code: 'server_error', message: round.error?.message ?? 'Fixture failure.' } : null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'test-model',
    object: 'response',
    output: round.output,
    parallel_tool_calls: false,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    status: failed ? 'failed' : 'completed',
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  } satisfies OpenAIResponse;
}

function validateContinuation(request: Record<string, unknown>, calls: ResponseOutputItem[]): void {
  const input = request.input as { type?: string; call_id?: string }[];
  for (const call of calls) {
    if (call.type !== 'function_call' && call.type !== 'custom_tool_call') continue;
    const callType = call.type;
    const outputType = callType === 'function_call' ? 'function_call_output' : 'custom_tool_call_output';
    if (!input.some(item => item.type === callType && item.call_id === call.call_id)) throw new Error(`Missing replayed ${callType} ${call.call_id}.`);
    if (!input.some(item => item.type === outputType && item.call_id === call.call_id)) throw new Error(`Missing ${outputType} ${call.call_id}.`);
  }
}

function sse(events: ResponseStreamEvent[]): globalThis.Response {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  return new globalThis.Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), {
    headers: { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' },
  });
}

function cancelledSse(signal: AbortSignal | null | undefined): globalThis.Response {
  return new globalThis.Response(new ReadableStream({
    start(controller) {
      const cancel = (): void => controller.error(signal?.reason ?? new Error('Fixture request cancelled.'));
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
