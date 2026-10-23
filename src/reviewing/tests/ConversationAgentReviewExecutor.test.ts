import { describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { ChatConversation } from '#src/chat/ChatConversation.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import type { ChatResponseStream } from '#src/chat/ChatResponseStream.js';
import { AgentReviewScope } from '#src/reviewing/AgentReview.js';
import { ConversationAgentReviewExecutor } from '#src/reviewing/ConversationAgentReviewExecutor.js';

describe(ConversationAgentReviewExecutor, () => {
  describe(ConversationAgentReviewExecutor.prototype.run, () => {
    it('sends the captured files to a fresh plan-mode conversation and forwards only text', async () => {
      const send = vi.fn(async (_request: unknown, response: ChatResponseStream, _signal: AbortSignal) => {
        response.push({ type: ChatResponsePartType.REASONING_SUMMARY, value: 'thinking' });
        response.push({ type: ChatResponsePartType.TEXT, value: 'First. ' });
        response.push({ type: ChatResponsePartType.TEXT, value: 'Second.' });
      });
      const createConversation = vi.fn(() => ({ send }) as unknown as ChatConversation);
      const onText = vi.fn();
      const signal = new AbortController().signal;
      const review = {
        id: 'review',
        repositoryUri: 'file:///workspace',
        scope: AgentReviewScope.STAGED,
        branch: '',
        label: 'Staged changes',
        accountProvider: 'fixture',
        accountId: 'account',
        model: 'test-model',
        files: [
          {
            path: 'src/é.ts',
            uri: 'file:///workspace/src/%C3%A9.ts',
            before: 'old',
            after: 'new',
            contextText: 'é context',
            revision: 'rev-1',
          },
        ],
      };

      await new ConversationAgentReviewExecutor(createConversation).run(review, onText, signal);

      expect(createConversation).toHaveBeenCalledWith(review);
      expect(onText.mock.calls).toEqual([['First. '], ['Second.']]);
      const [request, , forwardedSignal] = send.mock.calls[0]!;
      expect(forwardedSignal).toBe(signal);
      expect(request).toEqual({
        mode: AgentModeID.PLAN,
        text: expect.stringContaining('Comparison: Staged changes.'),
        attachments: [{ path: 'src/é.ts', revision: 'rev-1', text: 'é context', byteOrderMark: false, byteLength: 10 }],
      });
    });
  });
});
