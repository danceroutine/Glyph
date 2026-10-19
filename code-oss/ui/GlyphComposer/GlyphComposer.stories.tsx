import { autoModel } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { isolateComposer } from '#code-oss/storybook/decorators.tsx';
import {
  composerFixture,
  queuedMessageDocuments,
  markdownDraft,
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
        selectModel={() => {}}
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
