import type { Usage } from '#src/chat/Usage.js';
import type { ChatTranscriptTurn } from './ChatSessionRecord.ts';

/** Provider-reported usage for saved, completed turns; missing reports remain explicit. */
export interface ChatUsage extends Usage {
  readonly unreportedTurns: number;
}

export function toChatUsage(turns: readonly ChatTranscriptTurn[]): ChatUsage {
  const total: Usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
  let unreportedTurns = 0;
  for (const turn of turns) {
    if (!turn.usage) {
      unreportedTurns++;
      continue;
    }
    if (turn.usage.incomplete === true) unreportedTurns++;
    total.inputTokens += turn.usage.inputTokens;
    total.cachedInputTokens += turn.usage.cachedInputTokens;
    total.outputTokens += turn.usage.outputTokens;
    total.reasoningTokens += turn.usage.reasoningTokens;
    total.totalTokens += turn.usage.totalTokens;
  }
  return { ...total, unreportedTurns };
}
