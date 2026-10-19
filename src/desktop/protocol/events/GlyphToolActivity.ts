import type { GlyphShellCommand } from './GlyphShellCommand.ts';
export enum GlyphToolActivityStatus {
  STARTED = 'started',
  COMPLETED = 'completed',
  FAILED = 'failed',
  INTERRUPTED = 'interrupted',
}

export interface GlyphToolActivity {
  readonly id: string;
  readonly name: string;
  readonly status: GlyphToolActivityStatus;
  readonly summary?: string;
  readonly arguments?: string;
  /** Assistant text length when the call began; separates consecutive call groups. */
  readonly textOffset?: number;
  readonly shell?: GlyphShellCommand;
}
