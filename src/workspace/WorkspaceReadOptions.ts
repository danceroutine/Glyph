import type { PinnedSourceAuthority } from './PinnedSourceAuthority.ts';
import type { WorkspaceDisclosure } from './WorkspaceDisclosure.ts';

/** Bounds bytes before an adapter allocates, decodes, hashes, or transfers file contents. */
export interface WorkspaceReadOptions {
  /** Composed reads retain the source root and reservations through delivery. */
  readonly retainAccess?: (check: () => void) => void;
  /** Bind a model-bound snapshot to the location that supplied it until first delivery. */
  readonly source?: { readonly authority: PinnedSourceAuthority; readonly disclosure: WorkspaceDisclosure };
  readonly maxBytes?: number;
  /** Remaining physical I/O allowance for an operation that verifies a snapshot with multiple disk reads. */
  readonly physicalByteBudget?: number;
  /** A durable filesystem rename checkpoint may verify the exact two-link inode and already-reviewed bytes. */
  readonly interruptedRename?: { readonly identity: string; readonly revision: string };
}
