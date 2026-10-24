import { describe, expect, it, vi } from 'vitest';
import { FetchHttpClient } from '#src/http/FetchHttpClient.js';
import { HttpError } from '#src/errors/HttpError.js';
import type { Logger } from '#src/observability/Logger.js';

function fixture(transport: typeof fetch) {
  const records: unknown[] = [];
  const record = (message: string, data?: unknown) => {
    records.push({ message, data });
  };
  const logger: Logger = {
    forNamespace: () => logger,
    trace: record,
    debug: record,
    info: record,
    warn: record,
    error: record,
  };
  return { client: new FetchHttpClient(logger, transport), records };
}

describe('security: HTTP diagnostic confidentiality', () => {
  /**
   * An issuer or transport can put freshly issued credentials in an exception
   * before session redaction knows them. The generic HTTP logger runs even with
   * chat tracing disabled. Exercise real request/error handling with only the
   * transport replaced; diagnostic records must not copy attacker-controlled
   * messages, including non-Error throws. Requests must still fail as HttpError.
   */
  it.each([new Error('synthetic-refresh-canary'), 'synthetic-refresh-canary'])(
    'does not retain secret-bearing transport exceptions (%s)',
    async failure => {
      const { client, records } = fixture(
        vi.fn<typeof fetch>(async () => {
          throw failure;
        }),
      );
      await expect(client.get('https://issuer.example.test/token')).rejects.toBeInstanceOf(HttpError);
      expect(JSON.stringify(records)).not.toContain('synthetic-refresh-canary');
      expect(records).toContainEqual(expect.objectContaining({ message: 'http.failure' }));
    },
  );

  /**
   * Node's real JSON decoder may include response fragments in SyntaxError text.
   * A tiny malformed response tests this sink without an external OAuth request.
   * Neither parser diagnostics nor full response content may reach HTTP logs.
   */
  it('does not retain malformed response excerpts', async () => {
    const { client, records } = fixture(vi.fn<typeof fetch>(async () => new Response('synthetic-response-canary')));
    await expect(client.get('https://issuer.example.test/token')).rejects.toBeInstanceOf(HttpError);
    expect(JSON.stringify(records)).not.toContain('synthetic');
  });

  /**
   * A requested URL can itself contain private bytes in any component, not only
   * the query. Success and failure telemetry must therefore use bounded request
   * metadata rather than a raw URL. The transport still receives the exact URL;
   * this is diagnostic minimization, not outbound authorization or secret scanning.
   */
  it.each([true, false])('omits private URL components from diagnostics (success=%s)', async success => {
    const transport = vi.fn<typeof fetch>(async () => {
      if (!success) throw new Error('offline');
      return Response.json({ ok: true });
    });
    const { client, records } = fixture(transport);
    const target = 'https://synthetic-host-canary.example.test/synthetic-path-canary?token=synthetic-query-canary';
    if (success) await expect(client.get(target)).resolves.toMatchObject({ body: { ok: true } });
    else await expect(client.get(target)).rejects.toBeInstanceOf(HttpError);
    expect(transport.mock.calls[0]?.[0]).toBe(target);
    expect(JSON.stringify(records)).not.toContain('synthetic-');
  });
});
