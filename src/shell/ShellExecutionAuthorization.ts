import type { ShellSandboxProfile } from './ShellSandboxProfile.ts';

/** The execution boundary selected independently from the shell presentation layer. */
export interface ShellExecutionAuthorization {
  readonly sandboxProfile: ShellSandboxProfile;
  /** Host-owned, invocation-scoped resources; never accepted from model tool input. */
  readonly readOnlyPaths?: readonly string[];
}
