import { describe, expect, it, vi } from 'vitest';
import { WebHttpClient } from '#src/web/WebHttpClient.js';
import { AuthorizedWebTransport } from '#src/web/AuthorizedWebTransport.js';
import { WebDestinationResolver } from '#src/web/WebDestinationResolver.js';

function guarded(transport: typeof fetch) {
  const resolver = new WebDestinationResolver(async () => [{ address: '8.8.8.8', family: 4 }]);
  return new WebHttpClient(
    new AuthorizedWebTransport(undefined, resolver, (destination, options) => transport(destination.url, options))
      .fetch,
  );
}

describe('security: internal web destination consent', () => {
  /**
   * A model tool caller can supply a URL independently of shell networking
   * approval. Without an explicit internal-web grant, reject local/private
   * destinations before transport admission, not after reading a response. All
   * addresses here go only to a recording transport; no DNS or network occurs.
   * Separate consent tests cover one-shot and persisted workspace-wide grants.
   */
  it.each([
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.0.1/',
    'http://169.254.169.254/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
  ])('rejects a non-public destination before connecting: %s', async target => {
    const transport = vi.fn<typeof fetch>(
      async () => new Response('synthetic-private-response', { headers: { 'content-type': 'text/plain' } }),
    );
    const client = guarded(transport);
    await expect(client.read(target, new AbortController().signal)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * A public page can redirect at a later hop to a private service. Denial must
   * occur before the private request, preserving the allowed public hop. The
   * recorder never connects to the named hosts and cannot establish DNS binding.
   */
  it('rejects a public redirect to a private service before the second request', async () => {
    const transport = vi.fn<typeof fetch>(async (_target, options) => {
      expect(options?.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    });
    await expect(
      guarded(transport).read('https://public.example.test/', new AbortController().signal),
    ).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
  });

  /** An allowed fixture public page must remain readable without account headers. */
  it('allows an anonymous public-page response', async () => {
    const transport = vi.fn<typeof fetch>(async (_target, options) => {
      expect(options?.credentials).toBe('omit');
      expect(new Headers(options?.headers).has('authorization')).toBe(false);
      return new Response('public fixture', { headers: { 'content-type': 'text/plain' } });
    });
    await expect(
      guarded(transport).read('https://public.example.test/', new AbortController().signal),
    ).resolves.toMatchObject({ text: 'public fixture' });
  });
});
