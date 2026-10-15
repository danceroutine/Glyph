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
  readonly shell?: GlyphShellCommand;
}
