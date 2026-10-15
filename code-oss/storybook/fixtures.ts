import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import type { GlyphWorkbenchSelection } from '#src/desktop/workbench/GlyphWorkbenchSelection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';

export const selection: GlyphWorkbenchSelection = {
  uri: 'file:///preview/src/greeting.ts',
  path: 'src/greeting.ts',
  text: 'export const greet = (name: string) => `Hello, ${name}!`;',
  version: 3,
};

export const conversation: readonly GlyphTranscriptEntry[] = [
  { id: 'user-1', role: GlyphTranscriptRole.USER, text: 'How does the Glyph sidebar render?' },
  {
    id: 'assistant-1',
    role: GlyphTranscriptRole.ASSISTANT,
    text: 'The native pane mounts the Preact view and passes in state and callbacks. The transcript and composer render inside that view.\n\nYou can edit these components in Storybook and check the integration in Code OSS afterward.',
  },
  { id: 'diagnostic-1', role: GlyphTranscriptRole.DIAGNOSTIC, text: 'Preview conversation · no agent connected' },
];

export function workbenchState(overrides: Partial<GlyphWorkbenchState> = {}): GlyphWorkbenchState {
  return {
    accounts: [],
    models: [],
    chats: [],
    runs: [],
    proposals: [],
    ownerWindowId: 'storybook',
    readOnly: false,
    sequence: 0,
    usage: {},
    status: GlyphWorkbenchStatus.READY,
    transcript: [],
    ...overrides,
  };
}

export const previewActions: GlyphWorkbenchViewActions = {
  composer: new GlyphComposerState(),
  send: async () => {},
  cancel: () => {},
  writeShellInput: async () => {},
  stopShell: async () => {},
  answerQuestion: async () => {},
  decideApproval: async () => {},
  newChat: () => {},
  openChat: async () => {},
  selectAccount: async () => {},
  selectModel: async () => {},
};

export const failingActions: GlyphWorkbenchViewActions = {
  ...previewActions,
  composer: new GlyphComposerState(),
  send: async () => {
    throw new Error('Preview send failed. Your draft has been restored; try editing it and sending again.');
  },
};
