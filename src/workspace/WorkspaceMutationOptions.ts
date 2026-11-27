import type { WorkspaceReadOptions } from './WorkspaceReadOptions.ts';
/** Host-specific mutation metadata that does not affect editing-domain semantics. */
export interface WorkspaceMutationOptions {
  /** Durable id used by remote/editor adapters to deduplicate mutation retries. */
  readonly operationId?: string;
  readonly undoGroupId?: string;
  /** Save the edited working copy so commands see the applied change on disk. */
  readonly save?: boolean;
  /** Check working-copy state immediately before creating or deleting a file. */
  readonly beforePublish?: () => Promise<void>;
  /** Recheck host-owned metadata immediately before publishing a staged filesystem replacement. */
  readonly beforeReplace?: (stagedPath: string) => Promise<void>;
  readonly interruptedRename?: NonNullable<WorkspaceReadOptions['interruptedRename']>;
}
