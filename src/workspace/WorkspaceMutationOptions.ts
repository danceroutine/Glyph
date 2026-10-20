/** Host-specific mutation metadata that does not affect editing-domain semantics. */
export interface WorkspaceMutationOptions {
  /** Durable id used by remote/editor adapters to deduplicate mutation retries. */
  readonly operationId?: string;
  readonly undoGroupId?: string;
  /** Save the edited working copy so commands see the applied change on disk. */
  readonly save?: boolean;
}
