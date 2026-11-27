import { fileURLToPath } from 'node:url';
import type { PinnedSource, PinnedSourceAuthority } from './PinnedSourceAuthority.ts';

/** A source read through an authorized store. The identity comes from its open disk descriptor,
 * including when the editor supplied the content. These receipts never enter model or chat history. */
export interface SourceRead {
  readonly uri: string;
  readonly identity: string;
}

/** Host-only origin of a catalog entry. The first read supplies its metadata and the rest contribute to its body. */
export const sourceReads = Symbol('sourceReads');
export interface SourceOrigin {
  readonly [sourceReads]?: { readonly authority: PinnedSourceAuthority; readonly files: readonly SourceRead[] };
}

export interface SourcePin {
  readonly authority: PinnedSourceAuthority;
  readonly file: PinnedSource;
}

/** Pins the routes that supplied the frozen revisions. One batch per owning access policy verifies that
 * each original disk identity still matches, including when multiple rules reference the same file. */
export async function enrollSources(
  sources: readonly (SourceOrigin & { readonly id: string })[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, readonly SourcePin[]>> {
  const batches = new Map<PinnedSourceAuthority, Map<string, SourcePin | undefined>>();
  for (const source of sources) {
    const origin = source[sourceReads];
    if (!origin) continue;
    let batch = batches.get(origin.authority);
    if (!batch) batches.set(origin.authority, (batch = new Map()));
    for (const read of origin.files) batch.set(read.uri, undefined);
  }
  await Promise.all(
    [...batches].map(async ([authority, batch]) => {
      const uris = [...batch.keys()];
      const pins = await authority.capture(
        uris.map(uri => fileURLToPath(uri)),
        signal,
      );
      uris.forEach((uri, index) => batch.set(uri, { authority, file: pins[index]! }));
    }),
  );
  const origins = new Map<string, readonly SourcePin[]>();
  for (const source of sources) {
    const origin = source[sourceReads];
    if (!origin) continue;
    origins.set(
      source.id,
      origin.files.map(read => {
        const pin = batches.get(origin.authority)!.get(read.uri)!;
        if (pin.file.identity !== read.identity)
          throw new Error('A context source changed during discovery. Retry the turn.');
        return pin;
      }),
    );
  }
  return origins;
}

/** Recheck live trust, private paths and physical ancestry in batches immediately before releasing
 * previously captured bytes. Providers call the returned synchronous guard after awaiting credentials. */
export async function authorizeSources(pins: Iterable<SourcePin>, signal?: AbortSignal): Promise<() => void> {
  const batches = new Map<PinnedSourceAuthority, Set<PinnedSource>>();
  for (const { authority, file } of pins) {
    let batch = batches.get(authority);
    if (!batch) batches.set(authority, (batch = new Set()));
    batch.add(file);
  }
  const checks = await Promise.all([...batches].map(([authority, batch]) => authority.authorize([...batch], signal)));
  const check = () => {
    signal?.throwIfAborted();
    for (const run of checks) run();
  };
  check();
  return check;
}
