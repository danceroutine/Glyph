import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { sanitizeText } from '../shared/sanitizeText.ts';
import type { ShellPermissionState } from './useShellPermissionState.ts';

export type ShellPermissionProps = ShellPermissionState;

export function ShellPermission({
  command,
  workingDirectory,
  choices,
  highlightedChoice,
}: ShellPermissionProps): ReactElement {
  return (
    <Box
      backgroundColor="#20242c"
      borderColor="yellow"
      borderStyle="round"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
      width="100%"
    >
      <Text bold color="yellow">
        Shell permission required
      </Text>
      <Text dimColor>{sanitizeText(workingDirectory)}</Text>
      <Text>{sanitizeText(command)}</Text>
      {choices.map((choice, index) => (
        <Text key={choice.decision} {...(index === highlightedChoice ? { color: 'cyan' as const } : {})}>
          {index === highlightedChoice ? '› ' : '  '}
          {`${index + 1}. ${choice.label}`}
          <Text dimColor>{` — ${choice.description}`}</Text>
        </Text>
      ))}
      <Text dimColor>↑/↓ move Enter select Esc deny Ctrl+C cancel</Text>
    </Box>
  );
}
