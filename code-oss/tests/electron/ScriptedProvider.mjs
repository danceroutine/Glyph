import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { text as readText } from 'node:stream/consumers';
import { z } from 'zod';

/**
 * @typedef {{ type: string, text?: string, image_url?: string }} ResponseContentPart
 * @typedef {{
 *   type?: string,
 *   id?: string,
 *   role?: string,
 *   status?: string,
 *   name?: string,
 *   namespace?: string,
 *   call_id?: string,
 *   arguments?: string,
 *   input?: string,
 *   output?: string,
 *   content?: string | ResponseContentPart[],
 * }} ResponseInputItem
 * @typedef {{ model: string, stream: boolean, input: ResponseInputItem[], instructions?: string, tools?: unknown[] }} ResponseRequestBody
 * @typedef {{ input?: number, cached?: number, output?: number, reasoning?: number, total?: number }} ScriptedUsage
 * @typedef {{
 *   chunks?: string[],
 *   reasoning?: string[],
 *   output?: unknown[],
 *   usage?: ScriptedUsage | null,
 *   hold?: boolean,
 * }} ScriptedRound
 * @typedef {{ subject: string, email: string, token: string, models: { slug: string, name: string }[] }} ScriptedAccount
 * @typedef {{
 *   body: ResponseRequestBody,
 *   account: string,
 *   closed: boolean,
 *   completed: boolean,
 *   finish: () => void,
 * }} ScriptedRequest
 * @typedef {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => unknown} WebRouteHandler
 * @typedef {{ status?: number, contentType?: string, headers?: Record<string, string>, body?: string }} WebRouteResponse
 */

/** @type {z.ZodCustom<ResponseInputItem, ResponseInputItem>} */
const inputItemSchema = z.custom(value => typeof value === 'object' && value !== null);

const requestBodySchema = z
  .object({
    model: z.string(),
    stream: z.boolean(),
    input: z.array(inputItemSchema),
    tools: z.array(z.unknown()).optional(),
  })
  .loose();

/** Local Responses wire fixture, controlled by the test rather than by application internals. */
export class ScriptedProvider {
  /** @type {ScriptedRound[]} */
  rounds = [];

  /** @type {ScriptedRequest[]} */
  requests = [];
  /** @type {string[]} */
  errors = [];
  /** @type {Map<string, WebRouteHandler | WebRouteResponse>} */
  webRoutes = new Map();
  /** @type {{ url: string, headers: import('node:http').IncomingHttpHeaders }[]} */
  webRequests = [];
  /** @type {ScriptedRound | undefined} */
  fallback;
  url = '';
  server = createServer((request, response) => {
    void this.handle(request, response).catch(error => {
      this.errors.push(String(error));
      response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  /** @param {ScriptedAccount[]} [accounts] */
  constructor(
    accounts = [
      {
        subject: 'electron-fixture',
        email: 'fixture@example.invalid',
        token: 'glyph-electron-fixture-token',
        models: [{ slug: 'fixture-model', name: 'Scripted model' }],
      },
    ],
  ) {
    this.accounts = accounts;
  }

  /**
   * @param {string} text
   * @param {string} [id]
   */
  static message(text, id = 'fixture-message') {
    return {
      type: 'message',
      id,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
  }

  /**
   * @param {string} name
   * @param {unknown} input
   * @param {{ namespace?: string, callId?: string, inputKind?: 'json' | 'text' }} [options]
   */
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

  async start() {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    assert.ok(address !== null && typeof address === 'object', 'The scripted provider is not listening on a port.');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  /** @param {ScriptedRound[]} rounds */
  enqueue(...rounds) {
    this.rounds.push(...rounds);
  }

  /** @param {number} index */
  release(index) {
    const request = this.requests.at(index);
    assert.ok(request, `Provider request ${index} has not arrived.`);
    request.finish();
  }

  assertConsumed() {
    assert.deepEqual(this.errors, [], 'The provider received an unexpected or invalid request.');
    assert.equal(this.rounds.length, 0, 'Not all scripted provider rounds were requested.');
  }

  get settled() {
    return (
      this.errors.length === 0 &&
      this.rounds.length === 0 &&
      this.requests.every(request => request.completed || request.closed)
    );
  }

  reset() {
    this.fallback = undefined;
    this.rounds = [];
    this.requests = [];
    this.errors = [];
    this.webRoutes.clear();
    this.webRequests = [];
  }

  async close() {
    /** @type {Promise<void>} */
    const closed = new Promise((resolve, reject) => {
      this.server.close(error => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.server.closeAllConnections();
    await closed;
  }

  /**
   * @param {import('node:http').IncomingMessage} request
   * @param {import('node:http').ServerResponse} response
   */
  async handle(request, response) {
    if (request.method === 'GET' && request.url === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const url = request.url ?? '';
    if (url.startsWith('/web/')) {
      this.webRequests.push({ url, headers: request.headers });
      const route = this.webRoutes.get(url);
      if (!route) {
        response.writeHead(404).end();
        return;
      }
      if (typeof route === 'function') {
        await route(request, response);
        return;
      }
      response
        .writeHead(route.status ?? 200, { 'content-type': route.contentType ?? 'text/html', ...route.headers })
        .end(route.body ?? '');
      return;
    }

    const account = this.accounts.find(value => request.headers.authorization === `Bearer ${value.token}`);
    assert.ok(account, 'Unknown fixture account.');
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          models: account.models.map(model => ({ slug: model.slug, display_name: model.name, visibility: 'list' })),
        }),
      );
      return;
    }
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/responses');
    const body = requestBodySchema.parse(JSON.parse(await readText(request)));
    assert.ok(
      account.models.some(model => model.slug === body.model),
      'Model does not belong to the selected account.',
    );
    assert.equal(body.stream, true);
    const round = this.rounds.shift() ?? this.fallback;
    assert.ok(round, 'Unexpected extra provider request.');
    const id = `response-${this.requests.length}`;
    const messageId = `message-${id}`;
    let sequence = 0;
    /** @param {Record<string, unknown>} value */
    const event = value => response.write(`data: ${JSON.stringify({ ...value, sequence_number: sequence++ })}\n\n`);
    /** @type {ScriptedRequest} */
    const record = {
      body,
      account: account.subject,
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
            model: body.model,
            status: 'completed',
            error: null,
            incomplete_details: null,
            output: round.output ?? [ScriptedProvider.message(text, messageId)],
            usage:
              round.usage === null
                ? null
                : {
                    input_tokens: round.usage?.input ?? 3,
                    input_tokens_details: { cached_tokens: round.usage?.cached ?? 0, cache_write_tokens: 0 },
                    output_tokens: round.usage?.output ?? 2,
                    output_tokens_details: { reasoning_tokens: round.usage?.reasoning ?? 0 },
                    total_tokens: round.usage?.total ?? 5,
                  },
          },
        });
        response.end();
      },
    };
    this.requests.push(record);
    response.on('close', () => {
      record.closed = true;
    });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.flushHeaders();
    for (const delta of round.reasoning ?? []) {
      event({
        type: 'response.reasoning_summary_text.delta',
        item_id: `reasoning-${id}`,
        output_index: 0,
        summary_index: 0,
        delta,
      });
    }
    for (const delta of round.chunks ?? []) {
      event({ type: 'response.output_text.delta', item_id: messageId, output_index: 0, content_index: 0, delta });
    }
    if (round.hold !== true) record.finish();
  }
}
