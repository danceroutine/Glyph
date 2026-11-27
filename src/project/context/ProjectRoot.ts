/** One named filesystem root exposed by an active project context. */
export interface ProjectRoot {
  readonly name: string;
  readonly path: string;
  /** The CLI-selected route when it differs from the canonical directory used for persistence. */
  readonly selectedPath?: string;
}
