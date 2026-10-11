export enum GlyphToolActivityStatus {
  STARTED = 'started',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface GlyphToolActivity {
  readonly id: string;
  readonly name: string;
  readonly status: GlyphToolActivityStatus;
  readonly summary?: string;
}
