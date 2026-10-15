import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptedDesktopTransport } from '../ScriptedDesktopTransport.ts';

afterEach(() => vi.unstubAllGlobals());

describe(ScriptedDesktopTransport, () => {
  it.each([
    'https://127.0.0.1:1234',
    'http://localhost:1234',
    'http://example.invalid:1234',
    'http://127.0.0.1',
    'http://user:password@127.0.0.1:1234',
    'http://127.0.0.1:1234/path',
    'http://127.0.0.1:1234/?query=1',
    'http://127.0.0.1:1234/#fragment',
  ])('rejects a non-fixture endpoint: %s', endpoint => {
    expect(() => new ScriptedDesktopTransport(endpoint)).toThrow(/explicit http/);
  });

  it('routes the catalog and Responses body to loopback while preserving cancellation and blocking redirects', async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', network);
    const transport = new ScriptedDesktopTransport('http://127.0.0.1:1234');
    const controller = new AbortController();
    await transport.fetch('https://api.openai.com/v1/models');
    await transport.fetch(
      new Request('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: '{"stream":true}',
        headers: { authorization: 'Bearer fixture' },
        signal: controller.signal,
      }),
    );
    expect(String(network.mock.calls[0]![0])).toBe('http://127.0.0.1:1234/v1/models');
    expect(String(network.mock.calls[1]![0])).toBe('http://127.0.0.1:1234/v1/responses');
    const options = network.mock.calls[1]![1]!;
    expect(options).toMatchObject({ method: 'POST', body: '{"stream":true}', redirect: 'error' });
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer fixture');
    controller.abort();
    expect(options.signal?.aborted).toBe(true);
  });

  it.each([
    ['https://auth.openai.com/oauth/token', 'POST'],
    ['https://api.openai.com/v1/other', 'GET'],
    ['https://other.invalid/v1/models', 'GET'],
    ['https://api.openai.com/v1/responses', 'GET'],
    ['https://api.openai.com/v1/models', 'POST'],
  ])('never falls through to live networking for %s (%s)', async (url, method) => {
    const network = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', network);
    await expect(new ScriptedDesktopTransport('http://127.0.0.1:1234').fetch(url, { method })).rejects.toThrow(
      /fallback is disabled/,
    );
    expect(network).not.toHaveBeenCalled();
  });
});
