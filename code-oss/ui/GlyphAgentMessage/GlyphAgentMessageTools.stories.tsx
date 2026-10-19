import { progressFixture, projectToolCalls } from '#code-oss/storybook/fixtures/ToolFixtures.ts';

import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphAgentMessage } from './GlyphAgentMessage.wired.tsx';
import { agentMessageFixture } from '#code-oss/storybook/fixtures/MessageFixtures.ts';
import { agentMessageDecorators } from '#code-oss/storybook/decorators.tsx';
import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus as Status } from '#src/desktop/protocol/events/GlyphToolActivity.js';

const calls = projectToolCalls;
function ToolMessage({
  progress,
}: {
  readonly progress: NonNullable<ReturnType<typeof agentMessageFixture>['progress']>;
}) {
  return (
    <WiredGlyphAgentMessage
      entry={agentMessageFixture({ text: 'Checking how queued messages keep their attachments.', progress })}
      chatId="chat"
      actions={previewActionsFixture()}
    />
  );
}
const meta = {
  title: 'Glyph/Chat/In Transcript/Agent Message/Tool calls',
  component: ToolMessage,
  globals: { paneWidth: '600' },
  args: { progress: progressFixture({ reasoning: '', status: GlyphRunStatus.COMPLETED, tools: calls }) },
  decorators: agentMessageDecorators,
} satisfies Meta<typeof ToolMessage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CompletedGroup: Story = {};
export const SingleCall: Story = { args: { progress: { ...meta.args.progress, tools: [calls[0]!] } } };
export const RunningGroup: Story = {
  args: {
    progress: {
      ...meta.args.progress,
      status: GlyphRunStatus.STREAMING,
      tools: calls.map((call, index) => ({
        ...call,
        status: index ? Status.STARTED : Status.COMPLETED,
        ...(index ? { summary: '' } : {}),
      })),
    },
  },
};
export const RunningCall: Story = {
  args: {
    progress: {
      ...meta.args.progress,
      status: GlyphRunStatus.STREAMING,
      tools: [{ ...calls[1]!, status: Status.STARTED, summary: '' }],
    },
  },
};
export const FailedCall: Story = {
  args: {
    progress: {
      ...meta.args.progress,
      tools: [
        {
          ...calls[0]!,
          status: Status.FAILED,
          summary: 'Request timed out. The server did not respond within 30 seconds.',
        },
      ],
    },
  },
};
export const InterruptedGroup: Story = {
  args: {
    progress: {
      ...meta.args.progress,
      status: GlyphRunStatus.INTERRUPTED,
      tools: calls.map(call => ({ ...call, status: Status.STARTED, summary: '' })),
    },
  },
};
export const SeparateGroups: Story = {
  args: {
    progress: {
      ...meta.args.progress,
      tools: [...calls, ...calls.slice(0, 2).map(call => ({ ...call, id: `retry-${call.id}`, textOffset: 80 }))],
    },
  },
};
export const Narrow: Story = { ...RunningGroup, globals: { paneWidth: '280' } };
