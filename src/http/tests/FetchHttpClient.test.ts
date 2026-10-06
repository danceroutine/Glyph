import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../errors/HttpError.ts';
import type { Logger } from '../../observability/Logger.ts';
import { FetchHttpClient } from '../FetchHttpClient.ts';
import { HttpBodyEncoding } from '../HttpBodyEncoding.ts';

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
  });
});
