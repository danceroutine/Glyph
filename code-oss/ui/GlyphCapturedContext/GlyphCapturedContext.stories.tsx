import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphCapturedContext } from './GlyphCapturedContext.presentational.tsx';
const meta = {
  title: 'Glyph/Captured Context',
  component: GlyphCapturedContext,
  args: {
    attachment: {
      path: 'src/greeting.ts',
      revision: '4c6bea7e027f',
      text: 'export const greeting = "Hello, café 🌱";\n',
      range: { start: { line: 11, column: 1 }, end: { line: 12, column: 1 } },
    },
  },
} satisfies Meta<typeof GlyphCapturedContext>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Selection: Story = {};
export const DiffOriginal: Story = { args: { attachment: { ...meta.args.attachment, side: 'original' } } };
