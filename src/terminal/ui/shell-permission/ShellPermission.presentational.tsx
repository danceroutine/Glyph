import { useRef, useState, type ReactElement } from 'react';
import { Box, Text, useInput, useWindowSize, useBoxMetrics, type DOMElement } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { sanitizeText } from '#src/terminal/ui/shared/sanitizeText.js';
import type { ShellPermissionState } from './useShellPermissionState.ts';

export type ShellPermissionProps = ShellPermissionState & { active?: boolean };

export function ShellPermission({
  command,
  workingDirectory,
  choices,
  highlightedChoice,
  active = true,
}: ShellPermissionProps): ReactElement {
  const { rows, columns } = useWindowSize();
  const viewportRef = useRef<DOMElement | null>(null);
  const viewport = useBoxMetrics(viewportRef);
  const [offset, setOffset] = useState(0);
  const lines = wrapAnsi(sanitizeText(command), Math.max(1, columns - 4), { hard: true, trim: false }).split('\n');
  const page = Math.max(1, viewport.clientHeight - 1);
  const bottom = Math.max(0, lines.length - viewport.clientHeight);
  useInput(
    (_input, key) => {
      if (key.pageDown) setOffset(value => Math.min(bottom, value + page));
      if (key.pageUp) setOffset(value => Math.max(0, value - page));
    },
    { isActive: active },
  );
  if (rows < 16 || columns < 40)
    return <Text color="yellow">Resize terminal to review command. Esc denies; approval disabled.</Text>;
  return (
    <Box
      backgroundColor="#20242c"
      borderColor="yellow"
      borderStyle="round"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      width="100%"
      height={rows - 1}
      flexShrink={0}
    >
      <Text bold color="yellow">
        Shell permission required
      </Text>
      <Text dimColor wrap="truncate-end">
        {sanitizeText(workingDirectory)}
      </Text>
      <Box
        ref={viewportRef}
        flexDirection="column"
        flexGrow={1}
        flexBasis={0}
        overflow="hidden"
        contentOffsetY={Math.min(offset, bottom)}
      >
        <Box flexDirection="column" flexShrink={0}>
          <Text>{lines.join('\n')}</Text>
        </Box>
      </Box>
      {choices.map((choice, index) => (
        <Text
          wrap="truncate-end"
          key={choice.decision}
          {...(index === highlightedChoice ? { color: 'cyan' as const } : {})}
        >
          {index === highlightedChoice ? '› ' : '  '}
          {`${index + 1}. ${choice.label}`}
        </Text>
      ))}
      <Box height={2}>
        <Text dimColor>{choices[highlightedChoice]?.description}</Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        PgUp/PgDn command · ↑/↓ choice · Enter select · Esc deny
      </Text>
    </Box>
  );
}
