import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Box, useBoxMetrics, useInput, type DOMElement } from 'ink';
import type { TranscriptEntry } from './TranscriptEntry.ts';

export interface TerminalRootProps {
  entries: readonly TranscriptEntry[];
  display?: 'flex' | 'none';
  pagingActive?: boolean;
  height: number;
  response: ReactNode;
  backgroundShells?: ReactNode;
  interaction: ReactNode;
}

interface TranscriptViewportProps {
  entries: readonly TranscriptEntry[];
  response: ReactNode;
  active: boolean;
}

function TranscriptViewport({ entries, response, active }: TranscriptViewportProps): ReactElement {
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);
  const [position, setPosition] = useState<number | undefined>();
  const bottom = Math.max(0, content.height - viewport.clientHeight);
  const scrollOffset = Math.min(position ?? bottom, bottom);
  // Pin an absolute row while paging so streamed output cannot pull the user
  // away from older text. Reaching the bottom restores automatic following.
  // Subscribe only while the application owns interactive input. A mounted but
  // idle transcript must not retain raw mode after a prompt or review closes.
  useInput(
    (_input, key) => {
      if (key.pageUp) setPosition(Math.max(0, scrollOffset - Math.max(1, viewport.clientHeight - 1)));
      if (key.pageDown) {
        const next = scrollOffset + Math.max(1, viewport.clientHeight - 1);
        setPosition(next >= bottom ? undefined : next);
      }
    },
    { isActive: active },
  );

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
  pagingActive = false,
  height,
  response,
  backgroundShells,
  interaction,
}: TerminalRootProps): ReactElement {
  return (
    <Box display={display} flexDirection="column" height={height} overflow="hidden" width="100%">
      <TranscriptViewport
        key={entries[0]?.id ?? 'empty'}
        entries={entries}
        response={response}
        active={pagingActive && display !== 'none'}
      />
      {backgroundShells}
      {interaction}
    </Box>
  );
}
