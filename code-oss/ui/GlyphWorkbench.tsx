import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphComposer } from './GlyphComposer.tsx';
import { GlyphTranscript } from './GlyphTranscript.tsx';

interface GlyphWorkbenchProps {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
}

/** Keeps local composition state mounted as authoritative host state streams in. */
export function GlyphWorkbench({ state, actions }: GlyphWorkbenchProps) {
  // TODO: Add account/model, question, approval, tool, and proposal components
  // against the existing workbench interaction port.
  return (
    <div class="glyph-workbench">
      <GlyphTranscript entries={state.transcript} />
      <GlyphComposer status={state.status} selection={state.selection} actions={actions} />
    </div>
  );
}
