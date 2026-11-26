import type { TurnContextSnapshot } from '#src/context/turns/TurnContextEnvelope.js';
import type { TurnUsage } from './TurnUsage.ts';

export interface TurnResult {
  usage: TurnUsage | null;
  responseId: string;
  /** Exact instruction provenance used by this completed logical turn. */
  context?: TurnContextSnapshot;
}
