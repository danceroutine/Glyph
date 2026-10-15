import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphComposer } from './GlyphComposer.tsx';
import { GlyphTranscript } from './GlyphTranscript.tsx';
import { GlyphUsageSummary } from './GlyphUsageSummary.tsx';
import { css } from './emotion.ts';

/** Also used by standalone component stories to reproduce the pane layout. */
export const workbenchClassName = css({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
});

interface GlyphWorkbenchProps {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
}

/** Projects host updates without replacing the window-owned composer state. */
export function GlyphWorkbench({ state, actions }: GlyphWorkbenchProps) {
  // TODO: Add account/model, question, approval, and proposal components
  // against the existing workbench interaction port.
  return (
    <div class={`glyph-workbench ${workbenchClassName}`}>
      <GlyphTranscript entries={state.transcript} />
      {state.selectedChatId && <GlyphUsageSummary usage={state.usage[state.selectedChatId]} />}
      <GlyphComposer status={state.status} selection={state.selection} actions={actions} />
    </div>
  );
}
