import type { TurnUsage } from './TurnUsage.ts';

export interface TurnResult {
  usage: TurnUsage | null;
  responseId: string;
}
