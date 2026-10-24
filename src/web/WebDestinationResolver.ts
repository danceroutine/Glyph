import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { WebDestination } from './WebDestination.ts';
import { WebRequestError } from './WebRequestError.ts';

type AddressLookup = (hostname: string) => Promise<LookupAddress[]>;

/** Resolve once per redirect hop. Empty, invalid or excessive answers fail closed. */
export class WebDestinationResolver {
  constructor(
    private readonly lookupAddresses: AddressLookup = hostname => lookup(hostname, { all: true, order: 'verbatim' }),
  ) {}

  async resolve(url: URL, signal: AbortSignal): Promise<WebDestination> {
    signal.throwIfAborted();
    const hostname = url.hostname.replaceAll(/^\[|\]$/gu, '');
    const family = isIP(hostname);
    const addresses = family ? [{ address: hostname, family }] : await this.lookupUntilCancelled(hostname, signal);
    signal.throwIfAborted();
    if (
      addresses.length === 0 ||
      addresses.length > 64 ||
      addresses.some(address => ![4, 6].includes(address.family) || isIP(address.address) !== address.family)
    )
      throw new WebRequestError('DESTINATION_UNAVAILABLE', 'The website did not resolve to a usable address set.');
    return new WebDestination(url, addresses);
  }

  private lookupUntilCancelled(hostname: string, signal: AbortSignal): Promise<LookupAddress[]> {
    // Node's resolver cannot cancel its underlying OS lookup. Stop the caller
    // promptly, discard any late answer, and observe late failures explicitly.
    return new Promise((resolve, reject) => {
      const abort = () => {
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      void Promise.resolve()
        .then(() => this.lookupAddresses(hostname))
        .then(
          addresses => {
            signal.removeEventListener('abort', abort);
            resolve(addresses);
          },
          error => {
            signal.removeEventListener('abort', abort);
            reject(error);
          },
        );
    });
  }
}
