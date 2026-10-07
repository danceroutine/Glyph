/** The host-enforced filesystem and network boundary for one shell command. */
export enum ShellSandboxProfile {
  READ_ONLY = 'read_only',
  WORKSPACE_WRITE = 'workspace_write',
  FULL_ACCESS = 'full_access',
}
