import { fn } from 'storybook/test';
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
      selectFiles: fn<NonNullable<GlyphWorkbenchViewActions['context']['selectFiles']>>(async () => [
        await actions.context.captureFile(selectionFixture().uri),
      ]).mockName('ActionFixtures.selectFiles'),
      searchFiles: fn<NonNullable<GlyphWorkbenchViewActions['context']['searchFiles']>>(async query =>
        [selectionFixture()].filter(file => file.path.includes(query)).map(({ uri, path }) => ({ uri, path })),
      ).mockName('ActionFixtures.searchFiles'),
      captureFile: fn<NonNullable<GlyphWorkbenchViewActions['context']['captureFile']>>(async () => {
        const { range: _range, ...file } = selectionFixture();
        return { ...file, id: crypto.randomUUID(), kind: GlyphContextAttachmentKind.FILE };
      }).mockName('ActionFixtures.captureFile'),
      openAttachment: fn<() => Promise<void>>().mockName('ActionFixtures.openAttachment').mockResolvedValue(undefined),
      refreshAttachment: fn<NonNullable<GlyphWorkbenchViewActions['context']['refreshAttachment']>>(
        async attachment => attachment,
      ).mockName('ActionFixtures.refreshAttachment'),
      checkAttachment: fn<() => Promise<undefined>>()
        .mockName('ActionFixtures.checkAttachment')
        .mockResolvedValue(undefined),
    },
    composer: composerFixture(),
    send: fn<() => Promise<void>>().mockName('ActionFixtures.send').mockResolvedValue(undefined),
    branchChat: fn<() => Promise<void>>().mockName('ActionFixtures.branchChat').mockResolvedValue(undefined),
    restoreCheckpoint: fn<() => Promise<void>>()
      .mockName('ActionFixtures.restoreCheckpoint')
      .mockResolvedValue(undefined),
    cancel: fn().mockName('ActionFixtures.cancel'),
    writeShellInput: fn<() => Promise<void>>().mockName('ActionFixtures.writeShellInput').mockResolvedValue(undefined),
    stopShell: fn<() => Promise<void>>().mockName('ActionFixtures.stopShell').mockResolvedValue(undefined),
    answerQuestion: fn<() => Promise<void>>().mockName('ActionFixtures.answerQuestion').mockResolvedValue(undefined),
    decideApproval: fn<() => Promise<void>>().mockName('ActionFixtures.decideApproval').mockResolvedValue(undefined),
    reviewProposalFile: fn<() => Promise<void>>()
      .mockName('ActionFixtures.reviewProposalFile')
      .mockResolvedValue(undefined),
    decideProposalItems: fn<() => Promise<void>>()
      .mockName('ActionFixtures.decideProposalItems')
      .mockResolvedValue(undefined),
    newChat: fn().mockName('ActionFixtures.newChat'),
    openChat: fn<() => Promise<void>>().mockName('ActionFixtures.openChat').mockResolvedValue(undefined),
    selectAccount: fn<() => Promise<void>>().mockName('ActionFixtures.selectAccount').mockResolvedValue(undefined),
    selectModel: fn<() => Promise<void>>().mockName('ActionFixtures.selectModel').mockResolvedValue(undefined),
    moveQueuedToNewChat: fn<NonNullable<GlyphWorkbenchViewActions['moveQueuedToNewChat']>>()
      .mockName('ActionFixtures.moveQueuedToNewChat')
      .mockResolvedValue(undefined),
    sendImmediately: fn<NonNullable<GlyphWorkbenchViewActions['sendImmediately']>>()
      .mockName('ActionFixtures.sendImmediately')
      .mockResolvedValue(undefined),
    steer: fn<NonNullable<GlyphWorkbenchViewActions['steer']>>()
      .mockName('ActionFixtures.steer')
      .mockResolvedValue(undefined),
    selectMode: fn<NonNullable<GlyphWorkbenchViewActions['selectMode']>>()
      .mockName('ActionFixtures.selectMode')
      .mockResolvedValue(undefined),
    buildPlan: fn<NonNullable<GlyphWorkbenchViewActions['buildPlan']>>()
      .mockName('ActionFixtures.buildPlan')
      .mockResolvedValue(undefined),
    viewPlan: fn<NonNullable<GlyphWorkbenchViewActions['viewPlan']>>()
      .mockName('ActionFixtures.viewPlan')
      .mockResolvedValue(undefined),
    copyText: fn<NonNullable<GlyphWorkbenchViewActions['copyText']>>()
      .mockName('ActionFixtures.copyText')
      .mockResolvedValue(undefined),
    openLink: fn<NonNullable<GlyphWorkbenchViewActions['openLink']>>(async () => undefined).mockName(
      'ActionFixtures.openLink',
    ),
    openMessageSettings: fn().mockName('ActionFixtures.openMessageSettings'),
    ...overrides,
  };
  return actions;
}
export function failingActionsFixture(): GlyphWorkbenchViewActions {
  return previewActionsFixture({
    send: fn<NonNullable<GlyphWorkbenchViewActions['send']>>(async () => {
      throw new Error('Preview send failed. Your draft has been restored; try editing it and sending again.');
    }).mockName('ActionFixtures.send'),
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

export const codeDraft: GlyphPromptDocument = {
  parts: [{ type: 'text', text: "```ts\nconst foo: string = '';\n```" }],
  from: 0,
  to: 0,
};
