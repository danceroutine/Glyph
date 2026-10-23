import { describe, expect, it } from 'vitest';
import type { ChatTranscriptTurn } from '#src/chat/sessions/ChatSessionRecord.js';
import { toChatUsage } from '#src/chat/sessions/ChatUsage.js';

describe(toChatUsage, () => {
  it('totals reported usage and counts turns with missing or incomplete reports', () => {
    const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, reasoningTokens: 1, totalTokens: 15 };
    const turns = [{ usage }, { usage: { ...usage, incomplete: true } }, {}] as unknown as ChatTranscriptTurn[];

    expect(toChatUsage(turns)).toEqual({
      inputTokens: 20,
      cachedInputTokens: 4,
      outputTokens: 10,
      reasoningTokens: 2,
      totalTokens: 30,
      unreportedTurns: 2,
    });
  });

  it('reports zero usage for an empty transcript', () => {
    expect(toChatUsage([])).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      unreportedTurns: 0,
    });
  });
});
