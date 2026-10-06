import type { ReactElement } from 'react';
import { useWindowSize } from 'ink';
import { WiredPromptEditor } from './PromptEditor.wired.tsx';
import { WiredProposalReview } from './ProposalReview.wired.tsx';
import { WiredResponse } from './Response.wired.tsx';
import { TerminalRoot } from './TerminalRoot.presentational.tsx';
import type { TerminalRendererSnapshot } from './TerminalRendererSnapshot.ts';
import { useTerminalRootState } from './useTerminalRootState.ts';

export interface WiredTerminalRootProps {
  snapshot: TerminalRendererSnapshot;
}

export function WiredTerminalRoot({ snapshot }: WiredTerminalRootProps): ReactElement {
  const state = useTerminalRootState(snapshot);
  const { rows } = useWindowSize();
  if (state.review) return <WiredProposalReview request={state.review} />;

  const response = state.responseParts ? <WiredResponse parts={state.responseParts} /> : null;
  const interaction = state.prompt ? (
    <WiredPromptEditor key={state.prompt.id} request={state.prompt} interrupt={state.interrupt} />
  ) : null;
  return (
    <TerminalRoot entries={state.entries} height={Math.max(1, rows)} response={response} interaction={interaction} />
  );
}
