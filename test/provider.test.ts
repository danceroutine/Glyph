import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import { OpenAIProvider } from '../src/openai-provider.ts';
import { readConfig } from '../src/config.ts';
import { describeError } from '../src/errors.ts';

const config = readConfig('test-model', {});
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

function harness(replies: (() => Response | Promise<Response>)[]) {
  const requests: Record<string, unknown>[] = [];
  const client = new OpenAI({ apiKey: 'test-secret', maxRetries: 0, fetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const reply = replies.shift();
    assert.ok(reply, 'unexpected extra request');
    return reply();
  } });
  return { provider: new OpenAIProvider(config, async () => 'oauth-test-token', client), requests };
}
const options = () => ({ signal: new AbortController().signal, onText: (_text: string): void => {} });

test('streams split Unicode, reports usage, replays full state, and resets', async () => {
  const { provider, requests } = harness([
    () => sse([{ type: 'response.output_text.delta', delta: 'Hello 🧪' }, completed]),
    () => sse([completed]),
    () => sse([completed]),
  ]);
  let text = '';
  const result = await provider.send('first', { ...options(), onText: delta => { text += delta; } });
  assert.equal(text, 'Hello 🧪');
  assert.equal(result.usage?.totalTokens, 19);
  assert.equal(result.usage?.reasoningTokens, 2);
  await provider.send('second', options());
  assert.equal(requests[0]?.store, false);
  assert.equal(requests[0]?.stream, true);
  assert.equal('max_output_tokens' in (requests[0] ?? {}), false);
  assert.deepEqual(requests[0]?.include, ['reasoning.encrypted_content']);
  assert.deepEqual(requests[1]?.input, [
    { role: 'user', content: 'first' }, ...completed.response.output, { role: 'user', content: 'second' },
  ]);
  provider.reset();
  await provider.send('fresh', options());
  assert.deepEqual(requests[2]?.input, [{ role: 'user', content: 'fresh' }]);
});

for (const [name, events] of [
  ['truncated stream', [{ type: 'response.output_text.delta', delta: 'partial' }]],
  ['incomplete response', [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]],
  ['failed response', [{ type: 'response.failed', response: { error: { message: 'failure' } } }]],
] as const) {
  test(`${name} preserves previous conversation without committing failed turn`, async () => {
    const { provider, requests } = harness([() => sse([completed]), () => sse([...events]), () => sse([completed])]);
    await provider.send('first', options());
    await assert.rejects(provider.send('bad turn', options()));
    await provider.send('retry', options());
    assert.deepEqual(requests[2]?.input, [
      { role: 'user', content: 'first' }, ...completed.response.output, { role: 'user', content: 'retry' },
    ]);
  });
}

test('HTTP auth error points to subscription account permissions', async () => {
  const { provider } = harness([() => new Response(JSON.stringify({ error: { message: 'Invalid key test-secret', type: 'invalid_request_error', code: 'invalid_api_key' } }), { status: 401, headers: { 'content-type': 'application/json' } })]);
  await assert.rejects(provider.send('hi', options()), error => {
    const message = describeError(error);
    assert.match(message, /401/);
    assert.match(message, /ChatGPT account/);

    return true;
  });
});

test('cancellation rolls back and allows the next request', async () => {
  const { provider, requests } = harness([
    () => sse([{ type: 'response.output_text.delta', delta: 'partial' }, completed]),
    () => sse([completed]),
  ]);
  const controller = new AbortController();
  await assert.rejects(provider.send('cancelled', { signal: controller.signal, onText: () => controller.abort() }), /cancelled/);
  await provider.send('retry', options());
  assert.deepEqual(requests[1]?.input, [{ role: 'user', content: 'retry' }]);
});

test('configuration ignores API credentials and validates the timeout', () => {
  assert.equal(readConfig('chosen', { OPENAI_API_KEY: 'never-use-me' }).model, 'chosen');
  assert.throws(() => readConfig('chosen', { CHAT_TIMEOUT_MS: '-1' }), /positive integer/);
});
