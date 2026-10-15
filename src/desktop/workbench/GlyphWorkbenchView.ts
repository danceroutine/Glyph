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
  newChat(): void;
  openChat(chatId: string): Promise<void>;
  selectAccount(provider: string, accountId: string): Promise<void>;
  selectModel(model: string): Promise<void>;
}

export type GlyphWorkbenchMount = (
  container: HTMLElement,
  state: GlyphWorkbenchState,
  actions: GlyphWorkbenchViewActions,
) => GlyphWorkbenchView;
