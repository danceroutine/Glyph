import type { TurnUsage } from './TurnUsage.ts';
import type { AgentInstructionTurnSnapshot } from '#src/instructions/AgentInstructionSource.js';

export interface TurnResult {
  usage: TurnUsage | null;
  responseId: string;
  /** Exact instruction provenance used by this completed logical turn. */
  context?: AgentInstructionTurnSnapshot;
}
