export enum ShellPermissionMode {
  ASK = 'ask',
  ALLOW_SAFE = 'allow_safe',
  ALLOW_EVERYTHING = 'allow_everything',
}

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
