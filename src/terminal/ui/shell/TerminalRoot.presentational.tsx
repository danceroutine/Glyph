import { useRef, type ReactElement, type ReactNode } from 'react';
import { Box, useBoxMetrics, type DOMElement } from 'ink';
import type { TranscriptEntry } from './TranscriptEntry.ts';

export interface TerminalRootProps {
  entries: readonly TranscriptEntry[];
  display?: 'flex' | 'none';
  height: number;
  response: ReactNode;
  interaction: ReactNode;
}

interface TranscriptViewportProps {
  entries: readonly TranscriptEntry[];
  response: ReactNode;
}

function TranscriptViewport({ entries, response }: TranscriptViewportProps): ReactElement {
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const scrollOffset = Math.max(0, content.height - viewport.clientHeight);

  return (
    <Box
      ref={viewportRef}
      flexDirection="column"
      flexBasis={0}
      flexGrow={1}
      flexShrink={1}
      overflow="hidden"
      contentOffsetY={scrollOffset}
    >
      <Box ref={contentRef} flexDirection="column" flexShrink={0} width="100%">
        {entries.map(entry => (
          <Box key={entry.id} flexDirection="column" width="100%">
            {entry.content}
          </Box>
        ))}
        {response}
      </Box>
    </Box>
  );
}

export function TerminalRoot({
  entries,
  display = 'flex',
  height,
  response,
  interaction,
}: TerminalRootProps): ReactElement {
  return (
    <Box display={display} flexDirection="column" height={height} overflow="hidden" width="100%">
      <TranscriptViewport entries={entries} response={response} />
      {interaction}
    </Box>
  );
}
