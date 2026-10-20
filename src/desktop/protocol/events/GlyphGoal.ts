export interface GlyphGoal {
  readonly id: string;
  readonly objective: string;
  readonly status: 'active' | 'paused' | 'complete';
  readonly pauseReason?: 'user' | 'failed' | 'stalled';
  readonly createdAt: string;
  readonly continuationCount: number;
  readonly idleContinuationsWithoutToolCalls: number;
  readonly activeDurationMs: number;
  readonly activeSince?: string;
}
