import type { ReactElement } from 'react';
import { ProposalReview } from './ProposalReview.presentational.tsx';
import type { ProposalReviewRequest } from './ProposalReviewRequest.ts';
import { useProposalReviewState } from './useProposalReviewState.ts';

export interface WiredProposalReviewProps {
  request: ProposalReviewRequest;
}

export function WiredProposalReview({ request }: WiredProposalReviewProps): ReactElement {
  const state = useProposalReviewState(request);
  return <ProposalReview {...state} />;
}
