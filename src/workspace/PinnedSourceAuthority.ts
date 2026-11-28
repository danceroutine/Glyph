import type { WorkspaceAccessPolicy } from './policy/WorkspaceAccessPolicy.ts';

/** Host evidence for a previously admitted instruction file. Keep it outside prompts and client-controlled state. */
export interface PinnedSource {
  readonly path: string;
  /** Fingerprint of the selected filesystem route, including its parent directories and mount. */
  readonly origin: string;
  /** Identity of the descriptor observed at capture. Compare it with the descriptor that supplied the content. */
  readonly identity: string;
}

/** Captures admitted sources in a batch and authorizes each subsequent disclosure under the live host boundary. */
export interface PinnedSourceAuthority {
  /** Enroll the paths that contributed bytes. The reader compares each identity with the handle it read. */
  capture(paths: readonly string[], signal?: AbortSignal): Promise<readonly PinnedSource[]>;
  /** Inspect optional catalog entries in one batch, retaining an empty slot for each unavailable file. */
  capture(
    paths: readonly string[],
    signal: AbortSignal | undefined,
    availability: 'available',
  ): Promise<readonly (PinnedSource | null)[]>;
  /** Call the returned guard synchronously at transport handoff. Obtain fresh authorization for each disclosure. */
  authorize(pins: readonly PinnedSource[], signal?: AbortSignal): Promise<() => void>;
}

/** Native filesystem metadata for a batch of known file locations under one reservation snapshot. */
export interface SourceOriginReader {
  sourceOrigins(
    paths: readonly string[],
    privatePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly Omit<PinnedSource, 'path'>[]>;
  availableSourceOrigins(
    paths: readonly string[],
    privatePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly (Omit<PinnedSource, 'path'> | null)[]>;
}

/**
 * Checks the selected filesystem routes for one workspace or personal catalog. Capture binds a read to its
 * observed file. At each later disclosure, authorize checks those routes against the current reservations.
 * Its synchronous guard rechecks trust, cancellation and the policy generation at the final handoff.
 * A content revision belongs to the rule or skill snapshot and can survive an ordinary edit in place.
 */
export class NativePinnedSourceAuthority implements PinnedSourceAuthority {
  constructor(
    private readonly metadata: SourceOriginReader,
    private readonly policy: WorkspaceAccessPolicy,
    private readonly assertTrusted: () => void,
    private readonly selectRoute: (path: string) => { path: string; assertCurrent?: () => void } = path => ({ path }),
  ) {}

  capture(paths: readonly string[], signal?: AbortSignal): Promise<readonly PinnedSource[]>;
  capture(
    paths: readonly string[],
    signal: AbortSignal | undefined,
    availability: 'available',
  ): Promise<readonly (PinnedSource | null)[]>;
  async capture(
    paths: readonly string[],
    signal?: AbortSignal,
    availability?: 'available',
  ): Promise<readonly (PinnedSource | null)[]> {
    return (await this.inspect(paths, signal, availability)).sources;
  }

  async authorize(pins: readonly PinnedSource[], signal?: AbortSignal): Promise<() => void> {
    const { sources, assertCurrent } = await this.inspect(
      pins.map(pin => pin.path),
      signal,
    );
    if (sources.some((source, index) => source?.origin !== pins[index]!.origin))
      throw new Error('The instruction source location changed.');
    return assertCurrent;
  }

  private async inspect(paths: readonly string[], signal?: AbortSignal, availability?: 'available') {
    const operation = this.policy.beginOperation();
    // Strict capture and disclosure propagate route failures. Optional enrollment can retain the other attachments.
    function onRoute<T>(inspect: () => T): T | null {
      if (!availability) return inspect();
      try {
        return inspect();
      } catch {
        return null;
      }
    }
    const routes = paths.map(path => onRoute(() => this.selectRoute(path)));
    const roots = new Set(routes.flatMap(route => route?.assertCurrent ?? []));
    const unavailableRoots = new Set<() => void>();
    const assertCurrent = () => {
      operation.assertCurrent();
      for (const check of roots) {
        if (onRoute(check) === null) unavailableRoots.add(check);
      }
      this.assertTrusted();
      signal?.throwIfAborted();
    };
    assertCurrent();
    const admitted = routes.flatMap((route, index) =>
      route && !(route.assertCurrent && unavailableRoots.has(route.assertCurrent)) ? [{ route, index }] : [],
    );
    const selected = admitted.map(({ route }) => route.path);
    const inspected = availability
      ? await this.metadata.availableSourceOrigins(selected, operation.privatePaths, signal)
      : await this.metadata.sourceOrigins(selected, operation.privatePaths, signal);
    assertCurrent();
    if (inspected.length !== selected.length) throw new Error('Incomplete instruction source inspection.');
    const sources = new Array<PinnedSource | null>(paths.length).fill(null);
    for (const [i, { route, index }] of admitted.entries()) {
      const origin = inspected[i];
      if (origin && !(route.assertCurrent && unavailableRoots.has(route.assertCurrent)))
        sources[index] = { path: paths[index]!, ...origin };
    }
    return { sources, assertCurrent };
  }
}
