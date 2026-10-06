import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { UserPromptDraft } from '../UserPromptDraft.ts';
import { sanitizeText } from '../TerminalEditReviewer.ts';

export interface PromptRecordProps {
  label: string;
  draft: UserPromptDraft;
}

export function PromptRecord({ label, draft }: PromptRecordProps): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text bold color="cyan">
          {label}
        </Text>
        {sanitizeText(draft.prompt)}
      </Text>
      {draft.attachmentPaths.length > 0 ? (
        <Text dimColor>{`  attached: ${draft.attachmentPaths.map(sanitizeText).join(', ')}`}</Text>
      ) : null}
    </Box>
  );
}
