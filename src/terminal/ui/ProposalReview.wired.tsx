import type { ReactElement } from 'react';
import { ProposalReviewPresentational } from './ProposalReview.presentational.tsx';
import type { ProposalReviewRequest } from './ProposalReviewRequest.ts';
import { useProposalReviewState } from './useProposalReviewState.ts';

export interface ProposalReviewWiredProps {
  request: ProposalReviewRequest;
}

export function ProposalReviewWired({ request }: ProposalReviewWiredProps): ReactElement {
  const state = useProposalReviewState(request);
  return <ProposalReviewPresentational {...state} />;
}
