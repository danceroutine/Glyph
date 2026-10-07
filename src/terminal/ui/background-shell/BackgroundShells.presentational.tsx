import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ShellSessionSnapshot } from '#src/shell/ShellSessionSnapshot.ts';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.ts';
import { sanitizeText } from '../shared/sanitizeText.ts';

export interface BackgroundShellsProps {
  readonly sessions: readonly ShellSessionSnapshot[];
}

export function BackgroundShells({ sessions }: BackgroundShellsProps): ReactElement | null {
  if (sessions.length === 0) return null;
  return (
    <Box borderColor="gray" borderStyle="single" flexDirection="column" paddingX={1} width="100%">
      <Text bold>{`Background terminals (${sessions.length})`}</Text>
      {sessions.map(session => {
        const latest = latestOutputLine(session.outputTail);
        const failed = session.exitCode !== undefined && session.exitCode !== 0;
        return (
          <Text key={session.id}>
            <Text color={session.status === ShellSessionStatus.RUNNING ? 'yellow' : failed ? 'red' : 'green'}>
              {session.status === ShellSessionStatus.RUNNING ? '●' : failed ? '×' : '○'}
            </Text>
            {` ${session.id.slice(0, 8)}  ${sanitizeText(session.command || 'ready')}`}
            {session.wakePattern ? <Text color="cyan">{`  wake: ${sanitizeText(session.wakePattern)}`}</Text> : null}
            {latest ? <Text dimColor>{`  · ${sanitizeText(latest)}`}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function latestOutputLine(output: string): string {
  return (
    output
      .split(/\r\n|\r|\n/u)
      .map(line => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  );
}
