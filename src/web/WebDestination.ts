import { BlockList, isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';

const localV4 = new BlockList();
// Conservative non-public ranges from the IANA special-purpose registries.
// Special anycast exceptions require approval too; this is an admission rule,
// not a claim that every address in these ranges is unreachable from the Internet.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  localV4.addSubnet(address, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
// https://www.iana.org/assignments/iana-ipv6-special-registry/
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  specialV6.addSubnet(address, prefix, 'ipv6');

/** One resolved request target; approval and connection use this same address set. */
export class WebDestination {
  constructor(
    readonly url: URL,
    readonly addresses: readonly LookupAddress[],
  ) {}

  get requiresApproval(): boolean {
    return this.addresses.some(({ address }) => !isPublicWebAddress(address));
  }
}

export function isPublicWebAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !localV4.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}
