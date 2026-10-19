import { todoItems } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphTodoCard } from './GlyphTodoCard.wired.tsx';

const meta = {
  title: 'Glyph/Chat/In Composer/To-dos',
  component: WiredGlyphTodoCard,
  args: {
    items: todoItems,
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
