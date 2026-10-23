import type { ReactElement } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import type { ShellSessionSnapshot } from '#src/shell/ShellSessionSnapshot.js';
import { ShellSessionStatus } from '#src/shell/ShellSessionStatus.js';
import { sanitizeText } from '#src/terminal/ui/shared/sanitizeText.js';

export interface BackgroundShellsProps {
  readonly sessions: readonly ShellSessionSnapshot[];
}

export function BackgroundShells({ sessions }: BackgroundShellsProps): ReactElement | null {
  const { rows } = useWindowSize();
  if (sessions.length === 0) return null;
  // This is a status summary, not a terminal transcript. Reserve most of the
  // screen for the active interaction, regardless of command or session count.
  const limit = Math.max(0, Math.min(3, Math.floor(rows / 4) - 3));
  const visible = sessions.slice(0, limit);
  return (
    <Box borderColor="gray" borderStyle="single" flexDirection="column" flexShrink={0} paddingX={1} width="100%">
      <Text
        bold
        wrap="truncate"
      >{`Background terminals (${sessions.length})${sessions.length > limit ? ` · ${sessions.length - limit} more` : ''}`}</Text>
      {visible.map(session => {
        const latest = latestOutputLine(session.outputTail);
        const failed = session.exitCode !== undefined && session.exitCode !== 0;
        return (
          <Text key={session.id} wrap="truncate">
            <Text color={session.status === ShellSessionStatus.RUNNING ? 'yellow' : failed ? 'red' : 'green'}>
              {session.status === ShellSessionStatus.RUNNING ? '●' : failed ? '×' : '○'}
            </Text>
            {` ${session.id.slice(0, 8)}  ${compact(session.command || 'ready')}`}
            {session.wakePattern !== undefined && session.wakePattern !== '' ? (
              <Text color="cyan">{`  wake: ${compact(session.wakePattern)}`}</Text>
            ) : null}
            {latest ? <Text dimColor>{`  · ${sanitizeText(latest)}`}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

function compact(value: string): string {
  return sanitizeText(value).replaceAll(/\s+/gu, ' ').trim();
}

function latestOutputLine(output: string): string {
  return (
    output
      .split(/\r\n|\r|\n/u)
      .map(line => line.trim())
      .findLast(line => line !== '') ?? ''
  );
}
