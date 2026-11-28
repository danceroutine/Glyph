/** Execution characteristics used to keep automatic approvals narrowly scoped. */
export interface ShellAuthorizationContext {
  readonly background: boolean;
  readonly existingTerminal: boolean;
  /** Transient host-owned invocations cannot mint reusable pathname grants. */
  readonly transient?: boolean;
}
