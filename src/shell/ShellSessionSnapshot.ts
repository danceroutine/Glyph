import type { ShellSessionStatus } from './ShellSessionStatus.ts';

export interface ShellSessionSnapshot {
  readonly id: string;
  readonly ownerChatId?: string;
  readonly workingDirectory: string;
  readonly command: string;
  readonly status: ShellSessionStatus;
  readonly background: boolean;
  readonly outputTail: string;
  readonly startedAt: string;
  readonly exitCode?: number;
  readonly wakePattern?: string;
}
