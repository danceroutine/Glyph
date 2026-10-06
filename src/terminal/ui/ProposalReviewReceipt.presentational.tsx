import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import type { ProposalReviewSummary } from './ProposalReviewSummary.ts';

export type ProposalReviewReceiptProps = ProposalReviewSummary;

export function ProposalReviewReceipt({ accepted, rejected }: ProposalReviewReceiptProps): ReactElement {
  return (
    <Box marginTop={1}>
      <Text>
        <Text bold color="green">
          {'✓ Review complete'}
        </Text>
        <Text dimColor>{' — '}</Text>
        <Text color="green">{`${accepted} accepted`}</Text>
        <Text dimColor>{', '}</Text>
        <Text {...(rejected > 0 ? { color: 'red' as const } : {})}>{`${rejected} rejected`}</Text>
      </Text>
    </Box>
  );
}
