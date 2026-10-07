/** Strength of the revision precondition supplied by a workspace adapter. */
export enum WorkspaceMutationConsistency {
  /** The revision comparison and mutation are one indivisible host operation. */
  ATOMIC_VERSIONED = 'ATOMIC_VERSIONED',
  /** The adapter checks immediately before an atomic write, but external writers can still race it. */
  BEST_EFFORT_FILESYSTEM = 'BEST_EFFORT_FILESYSTEM',
}
