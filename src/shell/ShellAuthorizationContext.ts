/** Execution characteristics used to keep automatic approvals narrowly scoped. */
export interface ShellAuthorizationContext {
  readonly background: boolean;
  readonly existingTerminal: boolean;
}
