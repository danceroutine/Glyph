import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphTodoCard } from './GlyphTodoCard.wired.tsx';

const meta = {
  title: 'Glyph/To-dos',
  component: WiredGlyphTodoCard,
  args: {
    items: [
      { id: 'inspect', text: 'Inspect the current implementation', status: 'completed' },
      { id: 'implement', text: 'Implement the todo card', status: 'in_progress' },
      { id: 'verify', text: 'Verify persistence and chat isolation', status: 'pending' },
    ],
  },
} satisfies Meta<typeof WiredGlyphTodoCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InProgress: Story = {};
export const Completed: Story = { args: { items: meta.args.items.map(item => ({ ...item, status: 'completed' })) } };
export const LongList: Story = {
  args: {
    items: Array.from({ length: 39 }, (_, i) => ({
      id: String(i),
      text: `Task ${i + 1}: review the implementation and verify the result`,
      status: i < 30 ? 'completed' : 'pending',
    })),
  },
};
