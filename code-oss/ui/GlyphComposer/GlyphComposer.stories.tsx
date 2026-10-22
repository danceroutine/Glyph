import { GlyphContextCandidateKind } from '#src/desktop/workbench/GlyphContextActions.js';
import { GlyphContextAttachmentKind } from '#src/desktop/protocol/connection/GlyphContextAttachment.js';
import { fn, userEvent, within } from 'storybook/test';
import { autoModel } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { isolateComposer } from '#code-oss/storybook/decorators.tsx';
import {
  composerFixture,
  queuedMessageDocuments,
  markdownDraft,
  codeDraft,
  failingActionsFixture,
  previewActionsFixture,
  attachedActionsFixture,
} from '#code-oss/storybook/fixtures/ActionFixtures.ts';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { GlyphModelPicker } from '#code-oss/ui/GlyphModelPicker/GlyphModelPicker.presentational.tsx';

import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { WiredGlyphComposer } from './GlyphComposer.wired.tsx';
import { workbenchClassName } from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.presentational.tsx';

const meta = {
  title: 'Glyph/Chat/In Composer/Composer',
  component: WiredGlyphComposer,
  args: {
    status: GlyphWorkbenchStatus.READY,
    actions: previewActionsFixture(),
    modelControl: (
      <GlyphModelPicker
        model={autoModel.slug}
        label={autoModel.name}
        models={[{ value: autoModel.slug, label: autoModel.name }]}
        disabled={false}
        selectModel={fn().mockName('GlyphComposer.selectModel')}
      />
    ),
  },
  argTypes: {
    actions: { control: false },
    status: { control: 'select', options: Object.values(GlyphWorkbenchStatus) },
  },
  decorators: [
    isolateComposer,
    Story => (
      <div class={`glyph-workbench ${workbenchClassName}`}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WiredGlyphComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const AttachedSelection: Story = { args: { actions: attachedActionsFixture() } };
export const Streaming: Story = { args: { status: GlyphWorkbenchStatus.STREAMING } };
export const SendFailure: Story = { args: { actions: failingActionsFixture() } };

export const Plan: Story = {
  args: { actions: previewActionsFixture({ composer: composerFixture({ mode: AgentModeID.PLAN }) }) },
};
export const MarkdownDraft: Story = {
  args: { actions: previewActionsFixture({ composer: composerFixture({ document: markdownDraft }) }) },
};

export const QueuedMessages: Story = {
  args: {
    status: GlyphWorkbenchStatus.STREAMING,
    actions: previewActionsFixture({ composer: composerFixture({ queued: queuedMessageDocuments }) }),
  },
};

export const EditingQueuedMessage: Story = {
  ...QueuedMessages,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = canvas.getAllByRole('listitem')[0]!;
    row.focus();
    await userEvent.click(within(row).getByRole('button', { name: 'Edit queued message' }));
  },
};

export const CodeDraft: Story = {
  args: { actions: previewActionsFixture({ composer: composerFixture({ document: codeDraft }) }) },
};

const contextFiles = [
  'code-oss/ui/GlyphReviewControls/GlyphReviewControls.stories.tsx',
  'src/chat/runtime/AgentRuntime.ts',
  'src/chat/AgentMode.ts',
  'code-oss/ui/GlyphModePicker/GlyphModePicker.presentational.tsx',
  'code-oss/ui/GlyphComposer/GlyphComposer.presentational.tsx',
  'code-oss/ui/GlyphWorkbench/GlyphWorkbench.presentational.tsx',
  'docs/code-oss-integration-plan.md',
  'package.json',
].map(path => ({ path, uri: `file:///workspace/${path}` }));
const contextFolders = [
  'src/chat/runtime/',
  'src/chat/',
  'src/',
  'code-oss/ui/GlyphModePicker/',
  'code-oss/ui/',
  'code-oss/',
].map(path => ({ path, uri: `file:///workspace/${path}`, kind: GlyphContextCandidateKind.FOLDER }));
const contextCandidates = [
  contextFiles[0]!,
  ...contextFolders,
  ...contextFiles.slice(1),
  {
    path: './',
    uri: 'file:///workspace',
    name: 'harness-chat',
    kind: GlyphContextCandidateKind.FOLDER,
    ancestry: ['Users', 'pedro', 'coding', 'harness-chat'],
  },
];
const contextActions = previewActionsFixture();
const contextPickerActions = previewActionsFixture({
  context: {
    ...contextActions.context,
    searchFiles: fn<typeof contextActions.context.searchFiles>(async query =>
      contextCandidates.filter(file => file.path.toLowerCase().includes(query.toLowerCase())),
    ).mockName('ContextPicker.searchFiles'),
    captureFile: fn<typeof contextActions.context.captureFile>(async uri => ({
      ...(await contextActions.context.captureFile(uri)),
      uri,
      path: contextFiles.find(file => file.uri === uri)?.path ?? uri.split('/').at(-1)!,
    })).mockName('ContextPicker.captureFile'),
    captureFolder: fn<NonNullable<typeof contextActions.context.captureFolder>>(async uri => ({
      id: crypto.randomUUID(),
      uri,
      path: contextCandidates.find(file => file.uri === uri)!.path.replace(/\/$/u, ''),
      kind: GlyphContextAttachmentKind.FOLDER,
      text: 'Directory tree (preview)\n  AgentRuntime.ts',
      contentRevision: 'preview-tree',
    })).mockName('ContextPicker.captureFolder'),
  },
});

export const ContextPicker: Story = {
  args: { actions: contextPickerActions },
  decorators: [
    Story => (
      <div style={{ paddingTop: 380 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.type(within(canvasElement).getByRole('textbox', { name: 'Message Glyph' }), '@');
  },
};
export const ContextPickerWide: Story = {
  ...ContextPicker,
  globals: { paneWidth: '1000' },
};

export const ContextPickerFolder: Story = {
  ...ContextPickerWide,
  play: async context => {
    await ContextPicker.play!(context);
    await userEvent.hover(await within(context.canvasElement).findByRole('option', { name: 'src/chat/runtime/' }));
  },
};

const diagnosticComposer = composerFixture();
diagnosticComposer.insertAttachments([
  {
    id: 'diagnostic-capture',
    kind: GlyphContextAttachmentKind.DIAGNOSTIC,
    uri: 'file:///workspace/src/main.ts',
    path: 'src/main.ts',
    contentRevision: 'captured-diagnostic-revision',
    sourceRevision: 'editor-version-3',
    range: { start: { line: 7, column: 1 }, end: { line: 7, column: 22 } },
    text: 'Diagnostic (current)\nSource: TypeScript\nMessage: Type string is not assignable to type number.\n\nCaptured source:\nconst count: number = "3";',
  },
]);
export const IdeContextCapture: Story = {
  args: {
    actions: previewActionsFixture({
      composer: diagnosticComposer,
      context: {
        ...previewActionsFixture().context,
        checkAttachment: fn(async () => 'Captured IDE context. Capture again from the originating surface to refresh.'),
      },
    }),
  },
};
