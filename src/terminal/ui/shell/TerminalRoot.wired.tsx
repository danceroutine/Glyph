import type { ReactElement } from 'react';
import { Box, useWindowSize } from 'ink';
import { WiredPromptEditor } from '../prompt/PromptEditor.wired.tsx';
import { WiredProposalReview } from '../proposal/ProposalReview.wired.tsx';
import { WiredQuestionForm } from '../question/QuestionForm.wired.tsx';
import { WiredResponse } from '../response/Response.wired.tsx';
import { WiredShellPermission } from '../shell-permission/ShellPermission.wired.tsx';
import { WiredBackgroundShells } from '../background-shell/BackgroundShells.wired.tsx';
import { TerminalRoot } from './TerminalRoot.presentational.tsx';
import type { TerminalRendererSnapshot } from './TerminalRendererSnapshot.ts';
import { useTerminalRootState } from './useTerminalRootState.ts';

export interface WiredTerminalRootProps {
  snapshot: TerminalRendererSnapshot;
}

export function WiredTerminalRoot({ snapshot }: WiredTerminalRootProps): ReactElement {
  const state = useTerminalRootState(snapshot);
  const { rows } = useWindowSize();

  const response = state.responseParts ? <WiredResponse parts={state.responseParts} /> : null;
  const prompt = state.prompt ? (
    <Box display={state.question || state.shellPermission ? 'none' : 'flex'} flexDirection="column">
      <WiredPromptEditor
        key={state.prompt.id}
        request={state.prompt}
        interrupt={state.interrupt}
        active={!state.review && !state.question && !state.shellPermission}
      />
    </Box>
  ) : null;
  const interaction = (
    <>
      {prompt}
      {state.question ? <WiredQuestionForm request={state.question} active={!state.review} /> : null}
      {state.shellPermission ? <WiredShellPermission request={state.shellPermission} active={!state.review} /> : null}
    </>
  );
  return (
    <>
      <TerminalRoot
        entries={state.entries}
        display={state.review ? 'none' : 'flex'}
        height={Math.max(1, rows)}
        response={response}
        backgroundShells={<WiredBackgroundShells sessions={state.backgroundShells} />}
        interaction={interaction}
      />
      {state.review ? <WiredProposalReview request={state.review} /> : null}
    </>
  );
}
