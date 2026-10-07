export enum ShellToolName {
  /** Starts an authorized command or reuses an idle terminal slot. Long-running work may be backgrounded and assigned a one-shot output wake condition. */
  EXECUTE = 'execute_shell',
  /** Sends interactive stdin to a command that is already running. It cannot start a new command and therefore cannot bypass command authorization. */
  WRITE_INPUT = 'write_shell_input',
  /** Terminates the active process group, if any, and removes the background terminal from the host. */
  CLOSE = 'close_shell',
  /** Returns the live background-terminal catalog with status and bounded recent output. */
  LIST = 'list_shells',
}
