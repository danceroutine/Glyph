import { GlyphModelPicker } from '#code-oss/ui/GlyphModelPicker/GlyphModelPicker.presentational.tsx';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { WiredGlyphComposer } from './GlyphComposer.wired.tsx';
import { workbenchClassName } from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.presentational.tsx';
import { failingActions, previewActions, attachedActions } from '#code-oss/storybook/fixtures.ts';

const meta = {
  title: 'Glyph/Chat/Composer',
  component: WiredGlyphComposer,
  args: {
    status: GlyphWorkbenchStatus.READY,
    actions: previewActions,
    modelControl: (
      <GlyphModelPicker
        model="auto"
        label="Auto"
        models={[{ value: 'auto', label: 'Auto' }]}
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
export const AttachedSelection: Story = { args: { actions: attachedActions } };
export const Streaming: Story = { args: { status: GlyphWorkbenchStatus.STREAMING } };
export const SendFailure: Story = { args: { actions: failingActions } };

const planComposer = new GlyphComposerState();
planComposer.setMode('plan');
export const Plan: Story = { args: { actions: { ...previewActions, composer: planComposer } } };

const markdownComposer = new GlyphComposerState();
markdownComposer.setDocument({
  parts: [
    {
      type: 'text',
      text: '## Implementation notes\n\n1. Inspect the **existing behavior**\n2. Add focused tests\n   * Include the failure path\n\n> Keep the change small and reviewable.\n\nUse `pnpm test` to verify.',
    },
  ],
  from: 0,
  to: 0,
});
export const MarkdownDraft: Story = { args: { actions: { ...previewActions, composer: markdownComposer } } };
