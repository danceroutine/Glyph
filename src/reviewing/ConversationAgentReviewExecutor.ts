import { AgentModeID } from '#src/chat/AgentMode.js';
import type { ChatConversation } from '#src/chat/ChatConversation.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import type { AgentReviewExecutor } from './AgentReviewExecutor.ts';
import type { AgentReviewModel } from './AgentReview.ts';

/** Uses a fresh provider conversation with a read-only tool registry per review. */
export class ConversationAgentReviewExecutor implements AgentReviewExecutor {
  constructor(private readonly createConversation: (model: AgentReviewModel) => ChatConversation) {}
  async run(...[review, onText, signal]: Parameters<AgentReviewExecutor['run']>): Promise<void> {
    const conversation = this.createConversation(review);
    await conversation.send(
      {
        mode: AgentModeID.PLAN,
        text: [
          'Review the captured Git comparison for actionable bugs and regressions introduced by these changes.',
          `Comparison: ${review.label}.`,
          'Use the captured before/after revisions as the authority. Read/search tools may inspect surrounding current source, which may differ from the capture. Do not change files, request mode changes, or execute commands.',
          'Report concrete issues supported by the code, with their impact and the conditions that trigger them. Avoid speculative concerns and style-only suggestions. Order findings by severity.',
          'Return findings inside <glyph_review> and </glyph_review>, one JSON object per line with path (exact captured path), side ("modified" for after-revision locations, "original" for deleted lines in the before revision), line (one-based on that side), title, and body. Use original-side locations for partial deletions too, even when the file still exists. End with {"complete":true}. A clean review has only that completion record. Outside the tag give a brief summary and validation gaps.',
        ].join('\n\n'),
        attachments: review.files.map(file => ({
          path: file.path,
          revision: file.revision,
          text: file.contextText,
          byteOrderMark: false,
          byteLength: Buffer.byteLength(file.contextText),
        })),
      },
      {
        push: part => {
          if (part.type === ChatResponsePartType.TEXT) onText(part.value);
        },
      },
      signal,
    );
  }
}
