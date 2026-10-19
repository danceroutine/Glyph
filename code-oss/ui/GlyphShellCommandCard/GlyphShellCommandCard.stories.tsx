import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphShellCommandCard } from './GlyphShellCommandCard.wired.tsx';
import { previewActions } from '#code-oss/storybook/fixtures.ts';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';

const shell = {
  command: 'whoami',
  output: 'pedro\n',
  workingDirectory: '/workspace/glyph',
  sessionId: 'shell-1',
  background: false,
  live: false,
  running: false,
  exitCode: 0,
};
const activity = { id: 'call-1', name: 'execute_shell', status: GlyphToolActivityStatus.COMPLETED, shell };
const meta = {
  title: 'Glyph/Chat/Shell command',
  component: WiredGlyphShellCommandCard,
  args: { activity, chatId: 'chat', readOnly: false, actions: previewActions },
} satisfies Meta<typeof WiredGlyphShellCommandCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Completed: Story = {};
export const Failed: Story = {
  args: {
    activity: {
      ...activity,
      shell: { ...shell, output: 'Missing configuration.\n', exitCode: 2, error: 'Command exited with code 2.' },
    },
  },
};
const { exitCode: _exitCode, ...runningShell } = shell;
export const Interactive: Story = {
  args: {
    activity: {
      ...activity,
      shell: {
        ...runningShell,
        command: 'read name',
        output: 'Enter your name:\n',
        background: true,
        live: true,
        running: true,
      },
    },
  },
};
export const ReadOnly: Story = { args: { ...Interactive.args, readOnly: true } };
