export enum ShellPermissionMode {
  ASK = 'ask',
  ALLOW_SAFE = 'allow_safe',
  ALLOW_EVERYTHING = 'allow_everything',
}

/**
 * Persisted shell approval preferences for a project context. The approval
 * service consults these when deciding whether to prompt for a command. The
 * launcher separately applies the selected execution profile at spawn.
 */
export interface ShellPermissionPolicy {
  readonly schemaVersion: 2;
  readonly projectContextId: string;
  readonly mode: ShellPermissionMode;
  readonly allowedCommands: readonly ShellCommandGrant[];
}

export interface ShellCommandGrant {
  readonly command: string;
  readonly workingDirectory: string;
}
