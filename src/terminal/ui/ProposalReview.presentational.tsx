import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ProposalReviewState } from './useProposalReviewState.ts';

export type ProposalReviewPresentationalProps = ProposalReviewState;

export function ProposalReviewPresentational({
  rows,
  header,
  diagnostic,
  visibleLines,
  navigationHelp,
  decisionHelp,
  complete,
}: ProposalReviewPresentationalProps): ReactElement {
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
