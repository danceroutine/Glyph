import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphBackgroundTerminals } from './GlyphBackgroundTerminals.tsx';

const meta = {
  title: 'Glyph/Chat/In Composer/Background Terminals',
  component: GlyphBackgroundTerminals,
  args: {
    shells: [
      {
        id: 'ticker',
        chatId: 'chat',
        command: 'Background ticker for UI testing',
        workingDirectory: '/project',
        output: 'tick 1\ntick 2\n',
        running: true,
        wakePattern: 'ready',
      },
    ],
    open: async () => {},
    stop: async () => {},
  },
} satisfies Meta<typeof GlyphBackgroundTerminals>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Running: Story = {};
export const Multiple: Story = {
  args: {
    shells: [
      ...meta.args.shells,
      { ...meta.args.shells[0]!, id: 'tests', command: 'pnpm test --watch', wakePattern: 'PASS' },
    ],
  },
};
export const ReadOnly: Story = { args: { disabled: true } };
export const StopFailed: Story = {
  args: {
    stop: async () => {
      throw new Error('The terminal could not be stopped. Try again.');
    },
  },
};
