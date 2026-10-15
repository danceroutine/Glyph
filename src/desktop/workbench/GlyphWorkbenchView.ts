import type { GlyphWorkbenchState } from './GlyphWorkbenchState.ts';
import type { GlyphComposerState } from './GlyphComposerState.ts';

/** Keeps the workbench lifecycle independent of the component renderer. */
export interface GlyphWorkbenchView {
  update(state: GlyphWorkbenchState): void;
  dispose(): void;
}

/** Callbacks preserve the service's ownership of application behavior. */
export interface GlyphWorkbenchViewActions {
  readonly composer: GlyphComposerState;
  send(text: string): Promise<void>;
  cancel(): void;
}

export type GlyphWorkbenchMount = (
  container: HTMLElement,
  state: GlyphWorkbenchState,
  actions: GlyphWorkbenchViewActions,
) => GlyphWorkbenchView;
