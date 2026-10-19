import { AgentModeID } from '#src/chat/AgentMode.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import type { GlyphPromptDocument } from '#src/desktop/workbench/GlyphPromptDocument.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { GlyphContextAttachmentKind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { selectionFixture } from './WorkspaceFixtures.ts';

export interface ComposerFixtureOptions {
  readonly document?: GlyphPromptDocument;
  readonly mode?: AgentModeID;
  readonly attachedSelection?: boolean;
  readonly queued?: readonly GlyphPromptDocument[];
}
/** Mutable controller fixtures must be constructed for each mounted story. */
export function composerFixture({
  document,
  mode,
  attachedSelection = false,
  queued = [],
}: ComposerFixtureOptions = {}): GlyphComposerState {
  const composer = new GlyphComposerState();
  for (const draft of queued) {
    composer.setDocument(structuredClone(draft));
    composer.enqueueDraft();
  }
  if (document) composer.setDocument(structuredClone(document));
  if (mode) composer.setMode(mode);
  if (attachedSelection) {
    composer.setDraft('Explain ');
    composer.insertAttachments([selectionFixture()]);
  }
  return composer;
}
export const markdownDraft: GlyphPromptDocument = {
  parts: [
    {
      type: 'text',
      text: '## Implementation notes\n\n1. Inspect the **existing behavior**\n2. Add focused tests\n   * Include the failure path\n\n> Keep the change small and reviewable.\n\nUse `pnpm test` to verify.',
    },
  ],
  from: 0,
  to: 0,
};
export function previewActionsFixture(overrides: Partial<GlyphWorkbenchViewActions> = {}): GlyphWorkbenchViewActions {
  const actions: GlyphWorkbenchViewActions = {
    context: {
      selectFiles: async () => [await actions.context.captureFile(selectionFixture().uri)],
      searchFiles: async query => [selectionFixture()].filter(file => file.path.includes(query)),
      captureFile: async () => {
        const { range: _range, ...file } = selectionFixture();
        return { ...file, id: crypto.randomUUID(), kind: GlyphContextAttachmentKind.FILE };
      },
      openAttachment: async () => {},
      refreshAttachment: async attachment => attachment,
      checkAttachment: async () => undefined,
    },
    composer: composerFixture(),
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
    ...overrides,
  };
  return actions;
}
export function failingActionsFixture(): GlyphWorkbenchViewActions {
  return previewActionsFixture({
    send: async () => {
      throw new Error('Preview send failed. Your draft has been restored; try editing it and sending again.');
    },
  });
}
export function attachedActionsFixture(): GlyphWorkbenchViewActions {
  return previewActionsFixture({ composer: composerFixture({ attachedSelection: true }) });
}

export const queuedMessageDocuments: readonly GlyphPromptDocument[] = [
  { parts: [{ type: 'text', text: 'Verify the tests after implementing the changes.' }], from: 0, to: 0 },
  {
    parts: [
      { type: 'text', text: 'Review ' },
      { type: 'attachment', attachment: selectionFixture() },
    ],
    from: 0,
    to: 0,
  },
];
