import type { ChildProcess } from 'node:child_process';
import type { ShellExecutionAuthorization } from './ShellExecutionAuthorization.ts';
import type { ShellProgram } from './ShellProgram.ts';

/** Launches an authorized command without coupling session lifecycle to an OS sandbox implementation. */
export interface ShellProcessLauncher {
  /**
   * Launch the approved command, or the exact executable and arguments of `program` when supplied.
   * For a program, `command` is approval and transcript text only: adapters must never parse it
   * through a shell or use it as a fallback for an unsupported direct invocation.
   */
  launch(
    command: string,
    workingDirectory: string,
    authorization: ShellExecutionAuthorization,
    program?: ShellProgram,
  ): ChildProcess;
}
