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

/** A file enrolled by its owning source authority. */
export interface PinnedSourceFile {
  readonly authority: PinnedSourceAuthority;
  readonly file: PinnedSource;
}

/** An observed catalog read retains its original identity until its route can be pinned. */
interface CatalogRead {
  readonly authority: PinnedSourceAuthority;
  readonly read: SourceRead;
  file?: PinnedSource;
}

export type SourcePin = PinnedSourceFile | CatalogRead;

/** Enroll the catalog together so later ordinary edits preserve frozen bytes. If a batch contains
 * an unavailable path, defer its receipts to their first disclosure, which checks the original
 * read identities for just the selected sources. Cancellation always stops admission. */
export async function enrollSources(
  sources: readonly (SourceOrigin & { readonly id: string })[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, readonly SourcePin[]>> {
  const batches = new Map<PinnedSourceAuthority, CatalogRead[]>();
  const origins = new Map<string, readonly CatalogRead[]>();
  for (const source of sources) {
    const origin = source[sourceReads];
    if (!origin) continue;
    const receipts = origin.files.map(read => ({ authority: origin.authority, read }));
    origins.set(source.id, receipts);
    let batch = batches.get(origin.authority);
    if (!batch) batches.set(origin.authority, (batch = []));
    batch.push(...receipts);
  }
  await Promise.all(
    [...batches].map(async ([authority, reads]) => {
      try {
        await captureReads(authority, reads, signal);
      } catch {
        signal?.throwIfAborted();
      }
    }),
  );
  return origins;
}

async function captureReads(authority: PinnedSourceAuthority, reads: readonly CatalogRead[], signal?: AbortSignal) {
  const paths = new Map(reads.map(({ read }) => [read.uri, fileURLToPath(read.uri)]));
  const files = await authority.capture([...paths.values()], signal);
  if (files.length !== paths.size) throw new Error('Incomplete instruction source inspection.');
  const captured = new Map([...paths.keys()].map((uri, index) => [uri, files[index]!]));
  for (const receipt of reads) receipt.file ??= captured.get(receipt.read.uri)!;
}

/** Recheck live trust, private paths and physical ancestry in batches immediately before releasing
 * previously captured bytes. Providers call the returned synchronous guard after awaiting credentials. */
export async function authorizeSources(pins: Iterable<SourcePin>, signal?: AbortSignal): Promise<() => void> {
  const batches = new Map<PinnedSourceAuthority, Set<SourcePin>>();
  for (const pin of pins) {
    let batch = batches.get(pin.authority);
    if (!batch) batches.set(pin.authority, (batch = new Set()));
    batch.add(pin);
  }
  const checks = await Promise.all(
    [...batches].map(async ([authority, batch]) => {
      const pending = [...batch].filter((pin): pin is CatalogRead => 'read' in pin && !pin.file);
      if (pending.length > 0) await captureReads(authority, pending, signal);
      const files = new Set<PinnedSource>();
      for (const pin of batch) {
        const file = pin.file!;
        if ('read' in pin && file.identity !== pin.read.identity)
          throw new Error('A context source changed during discovery. Retry the turn.');
        files.add(file);
      }
      return authority.authorize([...files], signal);
    }),
  );
  const check = () => {
    signal?.throwIfAborted();
    for (const run of checks) run();
  };
  check();
  return check;
}
