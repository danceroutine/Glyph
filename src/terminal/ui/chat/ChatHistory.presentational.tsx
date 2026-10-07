import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ChatSessionSummary, ChatTranscriptTurn } from '../../../chat/sessions/ChatSessionRecord.ts';
import { ChatResponsePartType } from '../../../chat/ChatResponsePartType.ts';
import { PromptRecord } from '../prompt/PromptRecord.presentational.tsx';
import { WiredResponse } from '../response/Response.wired.tsx';
import { sanitizeText } from '../shared/sanitizeText.ts';

export interface ChatHistoryProps {
  summary: ChatSessionSummary;
  transcript: readonly ChatTranscriptTurn[];
  promptWidth: number;
}

/** Replays persisted turns through the same visual components as live chat. */
export function ChatHistory({ summary, transcript, promptWidth }: ChatHistoryProps): ReactElement {
  return (
    <Box flexDirection="column">
      <Text>{sanitizeText(`Chat ${summary.id.slice(0, 8)}  ${summary.title}  · ${summary.modelSlug}`)}</Text>
      {transcript.map((turn, index) => (
        <Box key={`${turn.createdAt}:${index}`} flexDirection="column">
          <PromptRecord
            label="you> "
            draft={{ prompt: turn.userText, attachmentPaths: turn.attachmentPaths }}
            maxWidth={promptWidth}
          />
          <WiredResponse
            parts={[
              ...(turn.reasoningSummary
                ? [
                    {
                      type: ChatResponsePartType.REASONING_SUMMARY,
                      value: sanitizeText(turn.reasoningSummary),
                    } as const,
                  ]
                : []),
              { type: ChatResponsePartType.TEXT, value: sanitizeText(turn.assistantText) },
            ]}
            footer={null}
          />
        </Box>
      ))}
    </Box>
  );
}
