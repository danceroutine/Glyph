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
  /** Call the returned guard synchronously at transport handoff. Obtain fresh authorization for each disclosure. */
  authorize(pins: readonly PinnedSource[], signal?: AbortSignal): Promise<() => void>;
}

/** Native filesystem metadata for a batch of known file locations under one reservation snapshot. */
export interface SourceOriginReader {
  /** Recheck the contributing attached directories after native inspection and at final disclosure. */
  beginSourceAccess?(paths: readonly string[]): () => void;
  sourceOrigins(
    paths: readonly string[],
    privatePaths: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly Omit<PinnedSource, 'path'>[]>;
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
  ) {}

  async capture(paths: readonly string[], signal?: AbortSignal): Promise<readonly PinnedSource[]> {
    const { sources } = await this.inspect(paths, signal);
    return sources;
  }

  async authorize(pins: readonly PinnedSource[], signal?: AbortSignal): Promise<() => void> {
    const { sources, assertCurrent } = await this.inspect(
      pins.map(pin => pin.path),
      signal,
    );
    if (sources.some((source, index) => source.origin !== pins[index]!.origin))
      throw new Error('The instruction source location changed.');
    return assertCurrent;
  }

  private async inspect(paths: readonly string[], signal?: AbortSignal) {
    const operation = this.policy.beginOperation();
    const checkRoots = this.metadata.beginSourceAccess?.(paths);
    const assertCurrent = () => {
      operation.assertCurrent();
      checkRoots?.();
      this.assertTrusted();
      signal?.throwIfAborted();
    };
    assertCurrent();
    const inspected = await this.metadata.sourceOrigins(paths, operation.privatePaths, signal);
    assertCurrent();
    if (inspected.length !== paths.length) throw new Error('Incomplete instruction source inspection.');
    return { sources: paths.map((path, i) => ({ path, ...inspected[i]! })), assertCurrent };
  }
}
