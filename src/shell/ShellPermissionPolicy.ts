export enum ShellPermissionMode {
  ASK = 'ask',
  ALLOW_SAFE = 'allow_safe',
  ALLOW_EVERYTHING = 'allow_everything',
}

export interface ShellPermissionPolicy {
  readonly schemaVersion: 1;
  readonly projectContextId: string;
  readonly mode: ShellPermissionMode;
  readonly allowedCommands: readonly string[];
}
