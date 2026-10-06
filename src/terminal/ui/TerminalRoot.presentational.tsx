import type { ReactElement, ReactNode } from 'react';
import { Box, Static } from 'ink';
import type { TranscriptEntry } from './TranscriptEntry.ts';

export interface TerminalRootProps {
  entries: readonly TranscriptEntry[];
  response: ReactNode;
  interaction: ReactNode;
}

export function TerminalRoot({ entries, response, interaction }: TerminalRootProps): ReactElement {
  return (
    <Box flexDirection="column">
      <Static items={[...entries]}>
        {entry => (
          <Box key={entry.id} flexDirection="column">
            {entry.content}
          </Box>
        )}
      </Static>
      {response}
      {interaction}
    </Box>
  );
}
