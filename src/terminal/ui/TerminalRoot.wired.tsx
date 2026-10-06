import type { ReactElement } from 'react';
import { PromptEditorWired } from './PromptEditor.wired.tsx';
import { ProposalReviewWired } from './ProposalReview.wired.tsx';
import { ResponseWired } from './Response.wired.tsx';
import { TerminalRootPresentational } from './TerminalRoot.presentational.tsx';
import type { TerminalRendererSnapshot } from './TerminalRendererSnapshot.ts';
import { useTerminalRootState } from './useTerminalRootState.ts';

export interface TerminalRootWiredProps {
  snapshot: TerminalRendererSnapshot;
}

export function TerminalRootWired({ snapshot }: TerminalRootWiredProps): ReactElement {
  const state = useTerminalRootState(snapshot);
  const response = state.responseParts ? <ResponseWired parts={state.responseParts} /> : null;
  const interaction = state.review ? (
    <ProposalReviewWired request={state.review} />
  ) : state.prompt ? (
    <PromptEditorWired key={state.prompt.id} request={state.prompt} interrupt={state.interrupt} />
  ) : null;
  return <TerminalRootPresentational entries={state.entries} response={response} interaction={interaction} />;
}
