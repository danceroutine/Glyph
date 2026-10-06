import type { ReactElement, ReactNode, Ref } from 'react';
import { Box, Text, type DOMElement } from 'ink';
import type { FileSearchMatch } from '../../../context/search/FileSearchMatch.ts';
import { sanitizeText } from '../shared/sanitizeText.ts';
import type { PromptEditorState } from './usePromptEditorState.ts';
import { formatPromptText } from './formatPromptText.ts';
import { PromptLayout } from './PromptLayout.ts';

export type PromptEditorProps = PromptEditorState & {
  rootRef?: Ref<DOMElement>;
};

export function PromptEditor({
  label,
  pendingChanges,
  text,
  cursor,
  attachments,
  matches,
  commandMatches,
  selectedMatch,
  searchError,
  rootRef,
}: PromptEditorProps): ReactElement {
  const promptText = formatPromptText(text, attachments, cursor);
  return (
    <Box
      ref={rootRef}
      backgroundColor="#20242c"
      borderBottom={false}
      borderColor="gray"
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      flexDirection="column"
      marginTop={PromptLayout.railTopMargin}
      paddingX={PromptLayout.railHorizontalPadding}
      width="100%"
    >
      {pendingChanges > 0 ? <PendingReviewEyebrow count={pendingChanges} /> : null}
      <Text wrap="hard">
        <Text bold color="cyan">
          {label}
        </Text>
        {promptText.segments.map((segment, index) =>
          segment.type === 'attachment' && segment.collapsed ? (
            <Text key={index} bold color="cyan">
              {sanitizeText(segment.value)}
            </Text>
          ) : (
            sanitizeText(segment.value)
          ),
        )}
      </Text>
      {matches.map((match, index) => (
        <Text key={match.path}>
          {index === selectedMatch ? <Text color="cyan">{'  › '}</Text> : '    '}
          {highlightMatch(match)}
        </Text>
      ))}
      {commandMatches.map((command, index) => (
        <Text key={command.value}>
          {index === selectedMatch ? <Text color="cyan">{'  › '}</Text> : '    '}
          <Text bold color="magentaBright">
            {command.value}
          </Text>
          <Text dimColor>{`  ${command.description}`}</Text>
        </Text>
      ))}
      {searchError ? <Text color="red">{`  File search: ${sanitizeText(searchError)}`}</Text> : null}
    </Box>
  );
}

function PendingReviewEyebrow({ count }: { count: number }): ReactElement {
  return (
    <Text>
      <Text bold color="magentaBright">{`${count} pending ${count === 1 ? 'change' : 'changes'}`}</Text>
      <Text dimColor>{' · '}</Text>
      <Text bold color="cyan">
        /review
      </Text>
      <Text dimColor> to resume</Text>
    </Text>
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
