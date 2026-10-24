import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizedWebTransport } from '#src/web/AuthorizedWebTransport.js';
import { WebDestinationResolver } from '#src/web/WebDestinationResolver.js';
import { WebDestination, isPublicWebAddress } from '#src/web/WebDestination.js';
import { WebHttpClient } from '#src/web/WebHttpClient.js';

describe('security: resolved web destinations', () => {
  /**
   * A failed request still closes its private dispatcher. If both graceful
   * close and forced destruction fail, their cleanup rejections must not crash
   * the host or replace the original request outcome. No socket is opened.
   */
  it('contains transport cleanup failures after a rejected exchange', async () => {
    const close = vi.spyOn(Agent.prototype, 'close').mockRejectedValueOnce(new Error('close failed'));
    const destroy = vi.spyOn(Agent.prototype, 'destroy').mockRejectedValueOnce(new Error('destroy failed'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('exchange failed');
      }),
    );
    try {
      await expect(new AuthorizedWebTransport().fetch('http://8.8.8.8')).rejects.toThrow('exchange failed');
      await vi.waitFor(() => {
        expect(destroy).toHaveBeenCalledOnce();
      });
      expect(close).toHaveBeenCalledOnce();
    } finally {
      close.mockRestore();
      destroy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  /** A stalled resolver cannot hold a cancelled fetch open or later admit a socket. */
  it('settles cancellation while DNS is still pending', async () => {
    let answer!: (addresses: { address: string; family: number }[]) => void;
    const pendingAnswer = new Promise<{ address: string; family: number }[]>(resolve => {
      answer = resolve;
    });
    const lookup = vi.fn(() => pendingAnswer);
    const exchange = vi.fn();
    const cancellation = new AbortController();
    const transport = new AuthorizedWebTransport(vi.fn(), new WebDestinationResolver(lookup), exchange);
    const pending = transport.fetch('https://fixture.test', { signal: cancellation.signal });
    const observed = pending.catch((error: unknown) => error);
    cancellation.abort(new Error('DNS cancelled'));
    let settled = false;
    void observed.then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(
        () => {
          expect(settled).toBe(true);
        },
        { timeout: 100, interval: 5 },
      );
    } finally {
      answer([{ address: '8.8.8.8', family: 4 }]);
    }
    await expect(observed).resolves.toMatchObject({ message: 'DNS cancelled' });
    expect(exchange).not.toHaveBeenCalled();
  });

  /** Request objects carry cancellation too; extracting only their URL must not lose it. */
  it('honors cancellation carried by a Request object', async () => {
    const cancellation = new AbortController();
    cancellation.abort(new Error('request cancelled'));
    const exchange = vi.fn(async () => new Response('unexpected'));
    const transport = new AuthorizedWebTransport(vi.fn(), undefined, exchange);
    await expect(transport.fetch(new Request('http://8.8.8.8', { signal: cancellation.signal }))).rejects.toThrow(
      'request cancelled',
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  /** The production resolver may resolve localhost, but that answer still needs consent. */
  it('requires approval after a real local DNS lookup without opening a socket', async () => {
    const exchange = vi.fn();
    await expect(
      new AuthorizedWebTransport(undefined, undefined, exchange).fetch('http://localhost'),
    ).rejects.toMatchObject({ code: 'DESTINATION_DENIED' });
    expect(exchange).not.toHaveBeenCalled();
  });
  /**
   * Resolver answers, not hostname appearance, determine private access. Mixed
   * results require approval even if the first answer is public. Denial, lookup
   * failure and cancellation must occur before exchange; fakes never use DNS.
   */
  it.for([
    [{ address: '127.0.0.1', family: 4 }],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
  ])('requires approval for a private or mixed resolver answer: %j', async addresses => {
    const exchange = vi.fn(async () => new Response('private fixture'));
    const approve = vi.fn(async () => {
      throw new Error('denied');
    });
    const transport = new AuthorizedWebTransport(approve, new WebDestinationResolver(async () => addresses), exchange);
    await expect(transport.fetch('https://public-looking.example.test')).rejects.toThrow('denied');
    expect(approve).toHaveBeenCalledOnce();
    expect(exchange).not.toHaveBeenCalled();
  });

  /**
   * An approved request uses precisely the address set shown for that request.
   * A hostile DNS change while approval is pending must not redirect the socket.
   * This layer asserts the binding handed to transport; a loopback test below
   * independently exercises the actual Agent lookup and HTTP Host preservation.
   */
  it('binds one approval to one resolved request and rechecks the next redirect', async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.2', family: 4 }]);
    const seen: string[] = [];
    const approve = vi.fn(async (destination: WebDestination) => {
      seen.push(destination.addresses[0]!.address);
    });
    const exchange = vi.fn(async (destination: WebDestination) => {
      expect(destination.addresses[0]!.address).toBe(seen.at(-1));
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: '/second' } })
        : new Response('approved fixture', { headers: { 'content-type': 'text/plain' } });
    });
    const client = new WebHttpClient(
      new AuthorizedWebTransport(approve, new WebDestinationResolver(lookup), exchange).fetch,
    );
    await expect(client.read('http://internal.example.test/', new AbortController().signal)).resolves.toMatchObject({
      text: 'approved fixture',
    });
    expect(seen).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  /** Cancellation while approval is open must not revive an admitted request. */
  it('does not connect when approval completes after cancellation', async () => {
    const cancellation = new AbortController();
    const exchange = vi.fn();
    const transport = new AuthorizedWebTransport(
      async () => {
        cancellation.abort(new Error('cancelled'));
      },
      undefined,
      exchange,
    );
    await expect(transport.fetch('http://127.0.0.1/', { signal: cancellation.signal })).rejects.toThrow('cancelled');
    expect(exchange).not.toHaveBeenCalled();
  });

  /** Empty, malformed, family-mismatched and excessive DNS answers grant no authority. */
  it.for([
    [],
    [{ address: 'invalid', family: 4 }],
    [{ address: '::1', family: 4 }],
    [{ address: '8.8.8.8', family: 3 }],
    Array.from({ length: 65 }, () => ({ address: '8.8.8.8', family: 4 })),
  ])('rejects unusable resolver answers without a connection: %j', async addresses => {
    const exchange = vi.fn();
    const transport = new AuthorizedWebTransport(vi.fn(), new WebDestinationResolver(async () => addresses), exchange);
    await expect(transport.fetch('https://fixture.example.test')).rejects.toMatchObject({
      code: 'DESTINATION_UNAVAILABLE',
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  /** DNS failures and cancellation before/after lookup fail closed, without hidden fallback. */
  it('propagates resolver failures and cancellation without exchanging a request', async () => {
    const exchange = vi.fn();
    const lookup = vi.fn(async () => {
      throw new Error('DNS fixture failure');
    });
    const transport = new AuthorizedWebTransport(vi.fn(), new WebDestinationResolver(lookup), exchange);
    await expect(transport.fetch('https://fixture.example.test')).rejects.toThrow('DNS fixture failure');
    const cancellation = new AbortController();
    cancellation.abort(new Error('cancelled'));
    await expect(transport.fetch('https://fixture.example.test', { signal: cancellation.signal })).rejects.toThrow(
      'cancelled',
    );
    expect(lookup).toHaveBeenCalledOnce();
    const cancelledLookup = new WebDestinationResolver(async () => {
      throw new Error('unused');
    });
    await expect(cancelledLookup.resolve(new URL('https://fixture.example.test'), cancellation.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(exchange).not.toHaveBeenCalled();
  });

  /**
   * Boundary controls cover IPv4/IPv6 global routing and conservative special
   * ranges. Invalid or mapped/translated addresses require approval; no string
   * supplied here is contacted. This is not an evolving routing-table oracle.
   */
  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['2001:4860:4860::8888', true],
    ['0.0.0.0', false],
    ['100.64.0.1', false],
    ['192.0.2.1', false],
    ['198.18.0.1', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['2001:db8::1', false],
    ['2001::1', false],
    ['2002::1', false],
    ['3fff::1', false],
    ['64:ff9b::1', false],
    ['::ffff:8.8.8.8', false],
    ['invalid', false],
  ] as const)('classifies %s as public=%s', (address, expected) => {
    expect(isPublicWebAddress(address)).toBe(expected);
  });

  /**
   * The only actual network target is this fixture-owned loopback server. A
   * nonresolving .test hostname is approved with its synthetic loopback answer;
   * successful receipt proves the real transport uses that answer, keeps Host,
   * and does not resolve the hostname again. Closing the server reclaims sockets.
   */
  it('uses the approved address in the real socket while preserving the URL hostname', async () => {
    const hosts: string[] = [];
    const server = createServer((request, response) => {
      hosts.push(request.headers.host!);
      response.setHeader('content-type', 'text/plain');
      response.end('synthetic-network-canary');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      const lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
      const approve = vi.fn(async () => {});
      const client = new WebHttpClient(new AuthorizedWebTransport(approve, new WebDestinationResolver(lookup)).fetch);
      const url = `http://approved-fixture.example.test:${address.port}/`;
      await expect(client.read(url, new AbortController().signal)).resolves.toMatchObject({
        text: 'synthetic-network-canary',
      });
      expect(hosts).toEqual([`approved-fixture.example.test:${address.port}`]);
      expect(lookup).toHaveBeenCalledOnce();
      expect(approve).toHaveBeenCalledOnce();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});

/** Human consent can take longer than the network budget; elapsed network time still accumulates across redirects. */
it('pauses the cumulative network deadline during consent and keeps cancellation live', async () => {
  vi.useFakeTimers();
  try {
    let answer!: () => void;
    const approve = vi.fn(
      () =>
        new Promise<void>(resolve => {
          answer = resolve;
        }),
    );
    const exchange = vi.fn(async (_destination, options: RequestInit) => {
      await new Promise(resolve => {
        setTimeout(resolve, 60);
      });
      options.signal!.throwIfAborted();
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/next' } });
    });
    const client = new WebHttpClient(new AuthorizedWebTransport(approve, undefined, exchange), {
      maxBytes: 1000,
      timeoutMs: 100,
      maxRedirects: 5,
    });
    const pending = client.read('http://127.0.0.1/start', new AbortController().signal);
    const observed = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(approve).toHaveBeenCalledOnce();
    expect(exchange).not.toHaveBeenCalled();
    answer();
    await vi.advanceTimersByTimeAsync(60);
    expect(approve).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    answer();
    await vi.advanceTimersByTimeAsync(60);
    await observed;
    const cancellation = new AbortController();
    const cancelled = client.read('http://127.0.0.1/start', cancellation.signal);
    const cancelledResult = expect(cancelled).rejects.toThrow('stop');
    await vi.advanceTimersByTimeAsync(1);
    cancellation.abort(new Error('stop'));
    answer();
    await cancelledResult;
  } finally {
    vi.useRealTimers();
  }
});
