import { Agent } from 'undici';
import { WebDestinationResolver } from './WebDestinationResolver.ts';
import type { WebDestination } from './WebDestination.ts';
import { webUrl } from './WebUrl.ts';
import { WebRequestError } from './WebRequestError.ts';

export type WebDestinationApproval = (destination: WebDestination, signal: AbortSignal) => Promise<void>;
type WebExchange = (destination: WebDestination, options: RequestInit) => Promise<Response>;

/** Host enforcement for web tools; each connection is pinned to an approved DNS answer. */
export class AuthorizedWebTransport {
  readonly fetch: typeof fetch = (input, options = {}) => this.request(input, options, operation => operation());

  constructor(
    private readonly approve: WebDestinationApproval = async () => {
      throw new WebRequestError('DESTINATION_DENIED', 'Internal web access requires explicit approval.');
    },
    private readonly resolver = new WebDestinationResolver(),
    private readonly exchange: WebExchange = fetchPinnedPage,
  ) {}

  async request(
    input: Parameters<typeof fetch>[0],
    options: RequestInit,
    awaitConsent: (operation: () => Promise<void>) => Promise<void>,
  ): Promise<Response> {
    const url = webUrl(input instanceof Request ? input.url : String(input));
    const signal = options.signal ?? (input instanceof Request ? input.signal : new AbortController().signal);
    const destination = await this.resolver.resolve(url, signal);
    if (destination.requiresApproval) await awaitConsent(() => this.approve(destination, signal));
    signal.throwIfAborted();
    return this.exchange(destination, { ...options, signal, redirect: 'manual', credentials: 'omit' });
  }
}

async function fetchPinnedPage(destination: WebDestination, options: RequestInit): Promise<Response> {
  const address = destination.addresses[0]!;
  // Preserve the URL hostname for TLS verification/SNI and HTTP Host, while
  // overriding only socket address lookup. There is no second DNS resolution,
  // unchecked fallback address, ambient proxy, or shared cross-request pool.
  const dispatcher = new Agent({
    connect: {
      autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => {
        callback(null, address.address, address.family);
      },
    },
  });
  try {
    const init = { ...options, dispatcher };
    return await fetch(destination.url, init);
  } finally {
    // Closing drains the response body; awaiting it here would deadlock the
    // caller that owns body consumption/cancellation. Destroy on close failure.
    void dispatcher.close().catch(() => dispatcher.destroy().catch(() => {}));
  }
}
