import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { UserPromptDraft } from './UserPromptDraft.ts';
import { sanitizeText } from '../shared/sanitizeText.ts';
import { formatPromptText } from './formatPromptText.ts';

export interface PromptRecordProps {
  label: string;
  draft: UserPromptDraft;
  maxWidth?: number;
}

export function PromptRecord({ draft, maxWidth = 64 }: PromptRecordProps): ReactElement {
  const promptText = formatPromptText(draft.prompt, draft.attachmentPaths);
  return (
    <Box alignSelf="flex-end" marginTop={1} maxWidth={maxWidth}>
      <Box backgroundColor="blue" borderColor="blue" borderStyle="round" paddingX={2}>
        <Text color="whiteBright">
          {promptText.segments.map((segment, index) =>
            segment.type === 'attachment' ? (
              <Text key={index} bold color="cyan">
                {sanitizeText(segment.value)}
              </Text>
            ) : (
              sanitizeText(segment.value)
            ),
          )}
        </Text>
      </Box>
    </Box>
  );
}
