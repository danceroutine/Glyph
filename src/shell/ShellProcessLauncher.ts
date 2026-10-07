import type { ChildProcess } from 'node:child_process';
import type { ShellExecutionAuthorization } from './ShellExecutionAuthorization.ts';

/** Launches an authorized command without coupling session lifecycle to an OS sandbox implementation. */
export interface ShellProcessLauncher {
  launch(command: string, workingDirectory: string, authorization: ShellExecutionAuthorization): ChildProcess;
}
