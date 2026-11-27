/**
 * Lets a managed domain reserve paths for its own mutation workflow. The edit
 * service consults this after workspace admission for each affected endpoint.
 * Approval, current window ownership and revision checks still belong to the
 * operation that publishes the edit.
 */
export interface ProjectMutationPolicy {
  /** A native managed-path check can supply the exact physical spelling independently of the collision key. */
  getDenial(canonicalPath: string, verifiedPhysicalPath?: string): string | undefined;
}
