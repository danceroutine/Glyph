import {
  progressFixture,
  shellFixture,
  shellActivityFixture,
  runFixture,
} from '#code-oss/storybook/fixtures/ToolFixtures.ts';

import { approvalFixture } from '#code-oss/storybook/fixtures/InteractionFixtures.ts';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphAgentMessage } from './GlyphAgentMessage.wired.tsx';
import { agentMessageFixture } from '#code-oss/storybook/fixtures/MessageFixtures.ts';
import { agentMessageDecorators } from '#code-oss/storybook/decorators.tsx';
import type { ComponentProps } from 'preact';
import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
import { GlyphToolActivityStatus, type GlyphToolActivity } from '#src/desktop/protocol/events/GlyphToolActivity.js';

const shell = shellFixture();
const activity = shellActivityFixture();
function ShellMessage({
  activity,
  ...props
}: Pick<ComponentProps<typeof WiredGlyphAgentMessage>, 'actions' | 'chatId' | 'readOnly'> & {
  readonly activity: GlyphToolActivity;
}) {
  return (
    <WiredGlyphAgentMessage
      {...props}
      entry={agentMessageFixture({
        text: 'I’ll run the project checks.',
        progress: progressFixture({
          reasoning: '',
          status: activity.shell?.running ? GlyphRunStatus.STREAMING : GlyphRunStatus.COMPLETED,
          tools: [activity],
        }),
      })}
    />
  );
}
const meta = {
  title: 'Glyph/Chat/In Transcript/Agent Message/Shell command',
  component: ShellMessage,
  decorators: agentMessageDecorators,
  args: { activity, chatId: 'chat', readOnly: false, actions: previewActionsFixture() },
} satisfies Meta<typeof ShellMessage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Completed: Story = {};
export const Failed: Story = {
  args: {
    activity: {
      ...activity,
      status: GlyphToolActivityStatus.FAILED,
      shell: { ...shell, output: 'Missing configuration.\n', exitCode: 2, error: 'Command exited with code 2.' },
    },
  },
};
const { exitCode: _exitCode, ...runningShell } = shell;
export const Interactive: Story = {
  args: {
    activity: {
      ...activity,
      status: GlyphToolActivityStatus.STARTED,
      shell: shellFixture({
        ...runningShell,
        command: 'read name',
        output: 'Enter your name:\n',
        background: true,
        live: true,
        running: true,
      }),
    },
  },
};
export const ReadOnly: Story = { args: { ...Interactive.args, readOnly: true } };

export const Approval: Story = {
  render: () => (
    <WiredGlyphAgentMessage
      entry={agentMessageFixture({ text: 'I’ll run the project tests.' })}
      chatId="chat"
      actions={previewActionsFixture()}
      pendingApproval={runFixture({
        chatId: 'chat',
        runId: 'run',
        text: '',
        reasoning: '',
        tools: [],
        status: GlyphRunStatus.WAITING_FOR_APPROVAL,
        approval: approvalFixture(),
      })}
    />
  ),
};
