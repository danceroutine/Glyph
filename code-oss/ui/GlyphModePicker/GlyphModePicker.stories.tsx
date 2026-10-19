import { AgentModeID } from '#src/chat/AgentMode.js';
import { useState } from 'preact/hooks';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphModePicker } from './GlyphModePicker.wired.tsx';
function ModePickerExample({ initial }: { readonly initial: AgentModeID }) {
  const [mode, change] = useState(initial);
  return <WiredGlyphModePicker mode={mode} change={change} />;
}
const meta = {
  title: 'Glyph/Chat/In Composer/Mode/Mode Picker',
  component: WiredGlyphModePicker,
  args: { mode: AgentModeID.AGENT, change: () => {} },
  decorators: [
    Story => (
      <div style={{ padding: '24px', paddingTop: '180px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WiredGlyphModePicker>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Agent: Story = { render: () => <ModePickerExample initial={AgentModeID.AGENT} /> };
export const Plan: Story = { render: () => <ModePickerExample initial={AgentModeID.PLAN} /> };
export const Menu: Story = {
  ...Plan,
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('[role="combobox"]')?.click();
  },
};
