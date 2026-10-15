import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';

/** Local Responses wire fixture, controlled by the test rather than by application internals. */
export class ScriptedProvider {
  rounds = [];
  requests = [];
  errors = [];
  server = createServer((request, response) => {
    void this.handle(request, response).catch(error => {
      this.errors.push(String(error));
      response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }));
    });
  });

  async start() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = `http://127.0.0.1:${this.server.address().port}`;
  }

  enqueue(...rounds) {
    this.rounds.push(...rounds);
  }

  release(index) {
    assert.ok(this.requests[index], `Provider request ${index} has not arrived.`);
    this.requests[index].finish();
  }

  assertConsumed() {
    assert.deepEqual(this.errors, [], 'The provider received an unexpected or invalid request.');
    assert.equal(this.rounds.length, 0, 'Not all scripted provider rounds were requested.');
  }

  async close() {
    const closed = new Promise((resolve, reject) => this.server.close(error => (error ? reject(error) : resolve())));
    this.server.closeAllConnections();
    await closed;
  }

  async handle(request, response) {
    assert.equal(request.headers.authorization, 'Bearer glyph-electron-fixture-token');
    if (request.method === 'GET' && request.url === '/v1/models') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({ models: [{ slug: 'fixture-model', display_name: 'Scripted model', visibility: 'list' }] }),
        );
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'fixture-model');
    assert.equal(body.stream, true);
    const round = this.rounds.shift();
    assert.ok(round, 'Unexpected extra provider request.');
    const id = `response-${this.requests.length}`;
    const messageId = `message-${id}`;
    let sequence = 0;
    const event = value => response.write(`data: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`);
    const record = {
      body,
      closed: false,
      completed: false,
      finish: () => {
        if (record.closed || record.completed) return;
        record.completed = true;
        const text = (round.chunks ?? []).join('');
        event({
          type: 'response.completed',
          response: {
            id,
            object: 'response',
            created_at: 0,
            model: 'fixture-model',
            status: 'completed',
            error: null,
            incomplete_details: null,
            output: round.output ?? [ScriptedProvider.message(text, messageId)],
            usage: {
              input_tokens: 3,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens: 2,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 5,
            },
          },
        });
        response.end();
      },
    };
    this.requests.push(record);
    response.on('close', () => (record.closed = true));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.flushHeaders();
    for (const delta of round.chunks ?? []) {
      event({ type: 'response.output_text.delta', item_id: messageId, output_index: 0, content_index: 0, delta });
    }
    if (!round.hold) record.finish();
  }

  static message(text, id = 'fixture-message') {
    return {
      type: 'message',
      id,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
  }

  static tool(name, input, { namespace = 'project', callId = 'fixture-call', inputKind = 'json' } = {}) {
    return inputKind === 'text'
      ? { type: 'custom_tool_call', id: `item-${callId}`, call_id: callId, namespace, name, input }
      : {
          type: 'function_call',
          id: `item-${callId}`,
          call_id: callId,
          namespace,
          name,
          arguments: JSON.stringify(input),
          status: 'completed',
        };
  }
}
