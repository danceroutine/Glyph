import {
  reasoningMessageFixture,
  interruptedMessageFixture,
  markdownMessageFixture,
  codeMessageFixture,
  completeMessageFixture,
} from '#code-oss/storybook/fixtures/MessageScenarios.ts';

import { agentMessageFixture } from '#code-oss/storybook/fixtures/MessageFixtures.ts';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphAgentMessage } from './GlyphAgentMessage.wired.tsx';

import { agentMessageDecorators } from '#code-oss/storybook/decorators.tsx';
import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';

const meta = {
  title: 'Glyph/Chat/In Transcript/Agent Message',
  component: WiredGlyphAgentMessage,
  args: { entry: agentMessageFixture(), chatId: 'chat', actions: previewActionsFixture() },
  decorators: agentMessageDecorators,
  globals: { paneWidth: '600' },
} satisfies Meta<typeof WiredGlyphAgentMessage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Completed: Story = {};
export const ReadOnly: Story = { args: { readOnly: true } };
export const ReasoningAndTools: Story = {
  args: {
    entry: reasoningMessageFixture(),
  },
};
export const InterruptedProgress: Story = {
  args: {
    entry: interruptedMessageFixture(),
  },
};
export const MarkdownAndMermaid: Story = {
  globals: { paneWidth: '600' },
  args: {
    actions: previewActionsFixture(),
    entry: markdownMessageFixture(),
  },
};

export const FencedCodeBlocks: Story = {
  globals: { paneWidth: '600' },
  args: {
    entry: codeMessageFixture(),
  },
};

/** A complete turn makes spacing between the individual pieces reviewable together. */
export const CompleteTurn: Story = {
  args: {
    entry: completeMessageFixture(),
  },
};
