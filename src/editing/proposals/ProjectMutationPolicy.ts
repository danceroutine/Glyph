/** Domain-owned restrictions on paths an agent can mutate through ordinary project edits. */
export interface ProjectMutationPolicy {
  /** A native managed-path check can supply the exact physical spelling independently of the collision key. */
  getDenial(canonicalPath: string, verifiedPhysicalPath?: string): string | undefined;
}
