import type { TurnResult } from './TurnResult.ts';

export interface ChatTurnResult extends TurnResult {
  durationMs: number;
}
