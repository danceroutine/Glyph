import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '#src/errors/HttpError.js';
import type { Logger } from '#src/observability/Logger.js';
import { FetchHttpClient } from '#src/http/FetchHttpClient.js';
import { HttpBodyEncoding } from '#src/http/HttpBodyEncoding.js';
import { HttpResponseBody } from '#src/http/HttpResponseBody.js';

function logger() {
  const debug = vi.fn<(message: string, data?: unknown) => void>();
  const error = vi.fn<(message: string, data?: unknown) => void>();
  const value = {
    forNamespace() {
      return this;
    },
    trace: vi.fn(),
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error,
  } satisfies Logger;
  return { value, debug, error };
}

describe(FetchHttpClient, () => {
  describe(FetchHttpClient.prototype.post, () => {
    it('formats form bodies and emits request and response telemetry without logging the body', async () => {
      const log = logger();
      const transport = vi.fn<typeof fetch>(async (_url, init) => {
        expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
        expect(String(init?.body)).toBe('client_id=client&refresh_token=secret');
        return Response.json({ access_token: 'access' });
      });
      const client = new FetchHttpClient(log.value, transport);

      expect(
        (
          await client.post('https://example.test/token', {
            body: { client_id: 'client', refresh_token: 'secret' },
            bodyEncoding: HttpBodyEncoding.FORM,
          })
        ).body,
      ).toEqual({ access_token: 'access' });

      expect(log.debug).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(log.debug.mock.calls)).not.toContain('secret');
    });

    it('wraps transport failures in a typed HTTP error and records the failure', async () => {
      const log = logger();
      const client = new FetchHttpClient(
        log.value,
        vi.fn<typeof fetch>(async () => {
          throw new Error('offline');
        }),
      );

      await expect(client.post('https://example.test/token')).rejects.toBeInstanceOf(HttpError);
      expect(log.error).toHaveBeenCalledWith('http.failure', expect.objectContaining({ error: 'offline' }));
    });

    it('serializes JSON bodies with a JSON content type', async () => {
      const transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
      const client = new FetchHttpClient(logger().value, transport);

      await client.post('https://example.test/items', { body: { name: 'glyph' }, bodyEncoding: HttpBodyEncoding.JSON });

      const init = transport.mock.calls[0]?.[1];
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
      expect(init?.body).toBe('{"name":"glyph"}');
    });

    it.each([
      ['text encoding', HttpBodyEncoding.TEXT],
      ['no encoding', undefined],
    ])('sends bodies as plain strings with %s', async (_case, bodyEncoding) => {
      const transport = vi.fn<typeof fetch>(async () => Response.json({}));
      const client = new FetchHttpClient(logger().value, transport);

      await client.post('https://example.test/items', { body: 42, ...(bodyEncoding ? { bodyEncoding } : {}) });

      const init = transport.mock.calls[0]?.[1];
      expect(init?.body).toBe('42');
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false);
    });

    it('reads text responses when requested', async () => {
      const client = new FetchHttpClient(
        logger().value,
        vi.fn<typeof fetch>(async () => new Response('plain body', { status: 201 })),
      );

      expect(await client.post('https://example.test/items', { responseBody: HttpResponseBody.TEXT })).toMatchObject({
        ok: true,
        status: 201,
        body: 'plain body',
      });
    });

    it('ignores response bodies when none is expected', async () => {
      const client = new FetchHttpClient(
        logger().value,
        vi.fn<typeof fetch>(async () => new Response('not json')),
      );

      expect(await client.post('https://example.test/items', { responseBody: HttpResponseBody.NONE })).toMatchObject({
        ok: true,
        status: 200,
        body: undefined,
      });
    });

    it('rethrows typed HTTP errors without wrapping them', async () => {
      const failure = new HttpError('already typed');
      const client = new FetchHttpClient(
        logger().value,
        vi.fn<typeof fetch>(async () => {
          throw failure;
        }),
      );

      await expect(client.post('https://example.test/items')).rejects.toBe(failure);
    });

    it('records non-error transport failures as text', async () => {
      const log = logger();
      const client = new FetchHttpClient(
        log.value,
        vi.fn<typeof fetch>(async () => Promise.reject('connection reset')),
      );

      await expect(client.post('https://example.test/items')).rejects.toThrow(
        'HTTP POST https://example.test/items failed.',
      );
      expect(log.error).toHaveBeenCalledWith('http.failure', expect.objectContaining({ error: 'connection reset' }));
    });

    it('still completes the request when logging fails', async () => {
      const log = logger();
      log.debug.mockImplementation(() => {
        throw new Error('log disk full');
      });
      const client = new FetchHttpClient(
        log.value,
        vi.fn<typeof fetch>(async () => Response.json({ ok: true })),
      );

      expect((await client.post('https://example.test/items')).body).toEqual({ ok: true });
    });
  });

  describe(FetchHttpClient.prototype.get, () => {
    it('sends a GET request combining the caller signal with the timeout', async () => {
      const transport = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
      const client = new FetchHttpClient(logger().value, transport);
      const controller = new AbortController();

      await client.get(new URL('https://example.test/status'), {
        signal: controller.signal,
        redirect: 'follow',
        headers: { Accept: 'application/json' },
      });

      const [url, init] = transport.mock.calls[0]!;
      expect(url).toBe('https://example.test/status');
      expect(init).toMatchObject({ method: 'GET', redirect: 'follow' });
      expect(init).not.toHaveProperty('body');
      expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
      expect(init?.signal?.aborted).toBe(false);
      controller.abort(new Error('Stopped'));
      expect(init?.signal?.aborted).toBe(true);
    });

    it('defaults to rejecting redirects', async () => {
      const transport = vi.fn<typeof fetch>(async () => Response.json({}));

      await new FetchHttpClient(logger().value, transport).get('https://example.test/status');

      expect(transport.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    });
  });
});
