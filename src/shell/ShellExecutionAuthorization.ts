import type { ShellSandboxProfile } from './ShellSandboxProfile.ts';

/** The execution boundary selected independently from the shell presentation layer. */
export interface ShellExecutionAuthorization {
  readonly sandboxProfile: ShellSandboxProfile;
}
