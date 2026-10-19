import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';

export const selection: GlyphContextAttachment = {
  uri: 'file:///preview/src/greeting.ts',
  path: 'src/greeting.ts',
  text: 'export const greet = (name: string) => `Hello, ${name}!`;',
  id: 'preview-selection',
  kind: GlyphContextAttachmentKind.SELECTION,
  contentRevision: 'preview-hash',
  sourceRevision: 'preview:3',
  token: {
    workspaceGeneration: 'preview',
    resource: 'file:///preview/src/greeting.ts',
    incarnation: 'preview',
    version: 3,
  },
  range: { start: { line: 11, column: 1 }, end: { line: 14, column: 2 } },
};

export const conversation: readonly GlyphTranscriptEntry[] = [
  {
    id: 'user-1',
    checkpointTurnId: 'assistant-1',
    role: GlyphTranscriptRole.USER,
    text: 'How does the Glyph sidebar render?',
  },
  {
    id: 'assistant-1',
    checkpointTurnId: 'assistant-1',
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
  context: {
    selectFiles: async () => [await previewActions.context.captureFile(selection.uri)],
    searchFiles: async query => [selection].filter(file => file.path.includes(query)),
    captureFile: async () => {
      const { range: _range, ...file } = selection;
      return { ...file, id: crypto.randomUUID(), kind: GlyphContextAttachmentKind.FILE };
    },
    openAttachment: async () => {},
    refreshAttachment: async attachment => attachment,
    checkAttachment: async () => undefined,
  },
  composer: new GlyphComposerState(),
  send: async () => {},
  branchChat: async () => {},
  restoreCheckpoint: async () => {},
  cancel: () => {},
  writeShellInput: async () => {},
  stopShell: async () => {},
  answerQuestion: async () => {},
  decideApproval: async () => {},
  reviewProposalFile: async () => {},
  decideProposalItems: async () => {},
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

export const attachedActions: GlyphWorkbenchViewActions = { ...previewActions, composer: new GlyphComposerState() };
attachedActions.composer.setDraft('Explain ');
attachedActions.composer.insertAttachments([selection]);
