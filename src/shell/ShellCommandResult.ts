export interface ShellCommandResult {
  readonly terminalId: string;
  readonly status: 'backgrounded' | 'completed';
  readonly output: string;
  readonly exitCode?: number;
}
