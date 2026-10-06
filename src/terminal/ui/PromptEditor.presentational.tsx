import type { ReactElement, ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { FileSearchMatch } from '../../context/search/FileSearchMatch.ts';
import { sanitizeText } from '../TerminalEditReviewer.ts';
import type { PromptEditorState } from './usePromptEditorState.ts';

export type PromptEditorProps = PromptEditorState;

export function PromptEditor({
  label,
  text,
  attachments,
  matches,
  selectedMatch,
  searchError,
}: PromptEditorProps): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text bold color="cyan">
          {label}
        </Text>
        {sanitizeText(text)}
      </Text>
      {attachments.length > 0 ? (
        <Text dimColor>{`  attached: ${attachments.map(sanitizeText).join(', ')}`}</Text>
      ) : null}
      {matches.map((match, index) => (
        <Text key={match.path}>
          {index === selectedMatch ? <Text color="cyan">{'  › '}</Text> : '    '}
          {highlightMatch(match)}
        </Text>
      ))}
      {searchError ? <Text color="red">{`  File search: ${sanitizeText(searchError)}`}</Text> : null}
    </Box>
  );
}

function highlightMatch(match: FileSearchMatch): ReactNode[] {
  const selected = new Set(match.indices);
  return [...sanitizeText(match.path)].map((character, index) =>
    selected.has(index) ? (
      <Text key={index} bold color="cyan">
        {character}
      </Text>
    ) : (
      character
    ),
  );
}
