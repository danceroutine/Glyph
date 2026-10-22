import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ProposalReviewState } from './useProposalReviewState.ts';

export type ProposalReviewProps = ProposalReviewState;

export function ProposalReview({
  rows,
  header,
  diagnostic,
  visibleLines,
  navigationHelp,
  decisionHelp,
  complete,
}: ProposalReviewProps): ReactElement {
  if (complete) return <Text dimColor>{header}</Text>;
  return (
    <Box flexDirection="column" height={rows}>
      {/* Control rows must match the fixed row budget used by review paging. */}
      <Text bold color="cyan" wrap="truncate">
        {header}
      </Text>
      {diagnostic ? (
        <Text bold color="red" wrap="truncate">
          {diagnostic.replaceAll(/[\r\n]+/gu, ' ')}
        </Text>
      ) : null}
      <Text>{visibleLines.join('\n')}</Text>
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate">
        {navigationHelp}
      </Text>
      <Text dimColor wrap="truncate">
        {decisionHelp}
      </Text>
    </Box>
  );
}
