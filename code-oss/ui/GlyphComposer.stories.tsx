import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { GlyphComposer } from './GlyphComposer.tsx';
import { workbenchClassName } from './GlyphWorkbench.tsx';
import { failingActions, previewActions, selection } from '#code-oss/storybook/fixtures.ts';

const meta = {
  title: 'Glyph/Composer',
  component: GlyphComposer,
  args: { status: GlyphWorkbenchStatus.READY, selection: undefined, actions: previewActions },
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
} satisfies Meta<typeof GlyphComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const AttachedSelection: Story = { args: { selection } };
export const Streaming: Story = { args: { status: GlyphWorkbenchStatus.STREAMING } };
export const SendFailure: Story = { args: { actions: failingActions } };
