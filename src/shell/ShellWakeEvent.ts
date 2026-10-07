export interface ShellWakeEvent {
  readonly id: string;
  readonly terminalId: string;
  readonly ownerChatId?: string;
  readonly pattern: string;
  readonly command: string;
  readonly workingDirectory: string;
  readonly output: string;
  readonly matchedAt: string;
}
