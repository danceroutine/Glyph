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
      <Text bold color="cyan">
        {header}
      </Text>
      {diagnostic ? (
        <Text bold color="red">
          {diagnostic}
        </Text>
      ) : null}
      <Text>{visibleLines.join('\n')}</Text>
      <Box flexGrow={1} />
      <Text dimColor>{navigationHelp}</Text>
      <Text dimColor>{decisionHelp}</Text>
    </Box>
  );
}
