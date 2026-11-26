/** Domain-owned restrictions on paths an agent can mutate through ordinary project edits. */
export interface ProjectMutationPolicy {
  /** The store resolves aliases and applies the owning root's casing before this check. */
  getDenial(canonicalPath: string): string | undefined;
}
