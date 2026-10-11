import type { ReactElement } from 'react';
import { Box, useWindowSize } from 'ink';
import { WiredPromptEditor } from '#src/terminal/ui/prompt/PromptEditor.wired.js';
import { WiredProposalReview } from '#src/terminal/ui/proposal/ProposalReview.wired.js';
import { WiredQuestionForm } from '#src/terminal/ui/question/QuestionForm.wired.js';
import { WiredResponse } from '#src/terminal/ui/response/Response.wired.js';
import { WiredShellPermission } from '#src/terminal/ui/shell-permission/ShellPermission.wired.js';
import { WiredBackgroundShells } from '#src/terminal/ui/background-shell/BackgroundShells.wired.js';
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
