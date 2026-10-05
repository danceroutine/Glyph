import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import type { ChatConfiguration } from '../../../configuration/ChatConfiguration.ts';
import { describeError } from '../../../describeError.ts';
import { ProjectAccess } from '../../../project/ProjectAccess.ts';
import type { ProviderTraceEntry } from '../../../chat/ProviderTraceEntry.ts';
import { OpenAIProvider } from '../OpenAIProvider.ts';

const configuration: ChatConfiguration = {
  instructions: 'You are a helpful assistant.',
  timeoutMs: 120_000,
};
const completed = {
  type: 'response.completed',
  response: {
    id: 'resp_test', status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque-state' },
      { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] },
    ],
    usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 19 },
  },
};

function sse(events: unknown[]): Response {
  // Split at arbitrary bytes, including through JSON and multibyte Unicode.
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(index, index + 7));
      index += 7;
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function harness(replies: (() => Response | Promise<Response>)[], project?: ProjectAccess) {
  const requests: Record<string, unknown>[] = [];
  const client = new OpenAI({ apiKey: 'test-secret', maxRetries: 0, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected extra request.');
    return reply();
  } });
  return {
    provider: new OpenAIProvider('test-model', configuration, async () => 'oauth-test-token', client, project),
    requests,
  };
}
const options = () => ({ signal: new AbortController().signal, onText: (_text: string): void => {} });

describe(OpenAIProvider, () => {
describe(OpenAIProvider.prototype.send, () => {
it('streams split Unicode, reports usage, replays full state, and resets', async () => {
  const { provider, requests } = harness([
    () => sse([{ type: 'response.output_text.delta', delta: 'Hello 🧪' }, completed]),
    () => sse([completed]),
    () => sse([completed]),
  ]);
  let text = '';
  const result = await provider.send('first', { ...options(), onText: delta => { text += delta; } });
  expect(text).toBe('Hello 🧪');
  expect(result.usage?.totalTokens).toBe(19);
  expect(result.usage?.reasoningTokens).toBe(2);
  await provider.send('second', options());
  expect(requests[0]?.store).toBe(false);
  expect(requests[0]?.stream).toBe(true);
  expect('max_output_tokens' in (requests[0] ?? {})).toBe(false);
  expect(requests[0]?.include).toEqual(['reasoning.encrypted_content']);
  expect(requests[0]?.tools).toEqual([
    expect.objectContaining({
      type: 'namespace',
      name: 'project',
      tools: [
        expect.objectContaining({ type: 'function', name: 'list_project_files' }),
        expect.objectContaining({ type: 'function', name: 'read_project_file' }),
      ],
    }),
  ]);
  expect(requests[1]?.input).toEqual([
    { role: 'user', content: 'first' }, ...completed.response.output, { role: 'user', content: 'second' },
  ]);
  provider.reset();
  await provider.send('fresh', options());
  expect(requests[2]?.input).toEqual([{ role: 'user', content: 'fresh' }]);
});

it('falls back to completed output when the stream omits text deltas', async () => {
  const { provider } = harness([() => sse([completed])]);
  let text = '';

  await provider.send('hello', { ...options(), onText: delta => { text += delta; } });

  expect(text).toBe('Hello');
});

it('traces the complete provider lifecycle without exposing the access token', async () => {
  const { provider } = harness([() => {
    const response = sse([completed]);
    response.headers.set('x-request-id', 'req_trace');
    response.headers.set('set-cookie', 'session=secret');
    return response;
  }]);
  const trace: ProviderTraceEntry[] = [];

  await provider.send('trace me', { ...options(), onTrace: entry => trace.push(entry) });

  expect(trace.map(entry => entry.kind)).toEqual([
    'turn.started',
    'authentication.resolved',
    'request.body',
    'response.http',
    'response.stream_event',
    'response.completed',
    'response.interpreted',
    'history.committed',
  ]);
  expect(trace.map(entry => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(trace.find(entry => entry.kind === 'authentication.resolved')?.data).toEqual({ accessToken: '[REDACTED]' });
  expect(trace.find(entry => entry.kind === 'request.body')?.data).toEqual(expect.objectContaining({
    model: 'test-model',
    input: [{ role: 'user', content: 'trace me' }],
    store: false,
    stream: true,
  }));
  expect(trace.find(entry => entry.kind === 'response.http')?.data).toEqual(expect.objectContaining({
    requestId: 'req_trace',
    status: 200,
    headers: expect.objectContaining({ 'set-cookie': '[REDACTED]', 'x-request-id': 'req_trace' }),
  }));
  expect(JSON.stringify(trace)).not.toContain('oauth-test-token');
});

it('rejects a terminal response with neither visible text nor a tool call', async () => {
  const empty = {
    type: 'response.completed',
    response: {
      ...completed.response,
      id: 'resp_empty',
      output: [{ type: 'reasoning', id: 'rs_empty', summary: [], encrypted_content: 'opaque-state' }],
    },
  };
  const { provider, requests } = harness([() => sse([empty]), () => sse([completed])]);

  await expect(provider.send('empty', options())).rejects.toThrow(/without returning text or a project tool call/);
  await provider.send('retry', options());

  expect(requests[1]?.input).toEqual([{ role: 'user', content: 'retry' }]);
});

it('executes project tools and continues until the model answers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-chat-provider-'));
  await writeFile(join(root, 'answer.ts'), 'export const answer = 42;\n');
  const toolResponse = {
    type: 'response.completed',
    response: {
      id: 'resp_tool', status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_tool', summary: [], encrypted_content: 'tool-reasoning' },
        {
          type: 'function_call', id: 'fc_read', call_id: 'call_read', status: 'completed',
          namespace: 'project',
          name: 'read_project_file',
          arguments: JSON.stringify({ path: 'answer.ts', start_line: null, end_line: null }),
        },
      ],
      usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 8 },
    },
  };
  const { provider, requests } = harness([
    () => sse([toolResponse]),
    () => sse([completed]),
    () => sse([completed]),
  ], new ProjectAccess(root));

  const result = await provider.send('What is the answer?', options());
  expect(result.responseId).toBe('resp_test');
  expect(result.usage?.totalTokens).toBe(27);
  expect(requests).toHaveLength(2);
  expect((requests[1]?.input as { type?: string }[]).map(item => item.type ?? 'message')).toEqual([
    'message', 'reasoning', 'function_call', 'function_call_output',
  ]);
  const toolOutput = (requests[1]?.input as { type?: string; output?: string }[]).find(item => item.type === 'function_call_output');
  expect(toolOutput?.output ?? '').toMatch(/export const answer = 42/);

  await provider.send('And again?', options());
  expect((requests[2]?.input as { type?: string }[]).filter(item => item.type === 'function_call_output')).toHaveLength(1);
});

it('collects output-item events when the terminal response output is empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-chat-buffered-provider-'));
  await writeFile(join(root, 'answer.ts'), 'export const answer = 42;\n');
  const reasoning = { type: 'reasoning', id: 'rs_buffered', summary: [], encrypted_content: 'buffered-state' };
  const call = {
    type: 'function_call', id: 'fc_buffered', call_id: 'call_buffered', status: 'completed',
    namespace: 'project', name: 'read_project_file',
    arguments: JSON.stringify({ path: 'answer.ts', start_line: null, end_line: null }),
  };
  const message = {
    type: 'message', id: 'msg_buffered', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'The answer is 42.', annotations: [] }],
  };
  const emptyTerminal = (id: string) => ({
    type: 'response.completed',
    response: { ...completed.response, id, output: [] },
  });
  const { provider, requests } = harness([
    () => sse([
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.done', output_index: 1, item: call },
      emptyTerminal('resp_buffered_call'),
    ]),
    () => sse([
      { type: 'response.output_item.done', output_index: 0, item: message },
      emptyTerminal('resp_buffered_message'),
    ]),
  ], new ProjectAccess(root));
  let text = '';
  const activity: { phase: string; name: string }[] = [];

  const result = await provider.send('What is the answer?', {
    ...options(),
    onText: delta => { text += delta; },
    onToolActivity: event => activity.push({ phase: event.phase, name: `${event.namespace}.${event.name}` }),
  });

  expect(result.responseId).toBe('resp_buffered_message');
  expect(text).toBe('The answer is 42.');
  expect(requests).toHaveLength(2);
  expect((requests[1]?.input as { type?: string }[]).map(item => item.type ?? 'message')).toEqual([
    'message', 'reasoning', 'function_call', 'function_call_output',
  ]);
  expect((requests[1]?.input as { type?: string; output?: string }[])
    .find(item => item.type === 'function_call_output')?.output).toMatch(/answer = 42/);
  expect(activity).toEqual([
    { phase: 'started', name: 'project.read_project_file' },
    { phase: 'completed', name: 'project.read_project_file' },
  ]);
});

for (const [name, events] of [
  ['truncated stream', [{ type: 'response.output_text.delta', delta: 'partial' }]],
  ['incomplete response', [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]],
  ['failed response', [{ type: 'response.failed', response: { error: { message: 'failure' } } }]],
] as const) {
  it(`${name} preserves previous conversation without committing failed turn`, async () => {
    const { provider, requests } = harness([() => sse([completed]), () => sse([...events]), () => sse([completed])]);
    await provider.send('first', options());
    await expect(provider.send('bad turn', options())).rejects.toThrow();
    await provider.send('retry', options());
    expect(requests[2]?.input).toEqual([
      { role: 'user', content: 'first' }, ...completed.response.output, { role: 'user', content: 'retry' },
    ]);
  });
}

it('reports subscription account permission failures from the API', async () => {
  const { provider } = harness([() => new Response(JSON.stringify({ error: { message: 'Invalid key test-secret', type: 'invalid_request_error', code: 'invalid_api_key' } }), { status: 401, headers: { 'content-type': 'application/json' } })]);
  try {
    await provider.send('hi', options());
    expect.unreachable('Expected provider.send to reject.');
  } catch (error) {
    const message = describeError(error);
    expect(message).toMatch(/401/);
    expect(message).toMatch(/ChatGPT account/);
  }
});

it('rolls back a cancelled turn and allows the next request', async () => {
  const { provider, requests } = harness([
    () => sse([{ type: 'response.output_text.delta', delta: 'partial' }, completed]),
    () => sse([completed]),
  ]);
  const controller = new AbortController();
  await expect(provider.send('cancelled', { signal: controller.signal, onText: () => controller.abort() })).rejects.toThrow(/cancelled/);
  await provider.send('retry', options());
  expect(requests[1]?.input).toEqual([{ role: 'user', content: 'retry' }]);
});

});
});
