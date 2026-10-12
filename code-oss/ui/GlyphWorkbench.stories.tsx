import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { GlyphWorkbench } from './GlyphWorkbench.tsx';
import { InteractiveWorkbench } from '../storybook/InteractiveWorkbench.tsx';
import { conversation, failingActions, previewActions, selection, workbenchState } from '../storybook/fixtures.ts';

const meta = {
  title: 'Glyph/Workbench',
  component: GlyphWorkbench,
  args: { state: workbenchState(), actions: previewActions },
  argTypes: { actions: { control: false } },
} satisfies Meta<typeof GlyphWorkbench>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = { render: () => <InteractiveWorkbench /> };
export const Empty: Story = {};
export const Conversation: Story = { args: { state: workbenchState({ transcript: conversation }) } };
export const AttachedSelection: Story = {
  args: { state: workbenchState({ transcript: conversation, selection }) },
};
export const Streaming: Story = {
  args: { state: workbenchState({ transcript: conversation, status: GlyphWorkbenchStatus.STREAMING }) },
};
export const SendFailure: Story = { args: { actions: failingActions } };
