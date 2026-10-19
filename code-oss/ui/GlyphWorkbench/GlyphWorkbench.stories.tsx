import { markdownMessageFixture } from '#code-oss/storybook/fixtures/MessageScenarios.ts';
import { isolateComposer } from '#code-oss/storybook/decorators.tsx';
import {
  autoModel,
  navigationStateFixture,
  chatFixture,
  todoItems,
  pendingProposals,
  workbenchStateFixture,
} from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { userMessageFixture, usageFixture, conversationFixture } from '#code-oss/storybook/fixtures/MessageFixtures.ts';

import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { WiredGlyphWorkbench } from './GlyphWorkbench.wired.tsx';
import { InteractiveWorkbench } from '#code-oss/storybook/InteractiveWorkbench.tsx';

import {
  composerFixture,
  queuedMessageDocuments,
  failingActionsFixture,
  previewActionsFixture,
  attachedActionsFixture,
} from '#code-oss/storybook/fixtures/ActionFixtures.ts';

const meta = {
  title: 'Glyph/Chat/Workbench',
  component: WiredGlyphWorkbench,
  args: { state: workbenchStateFixture(), actions: previewActionsFixture() },
  decorators: [isolateComposer],
  argTypes: { actions: { control: false } },
} satisfies Meta<typeof WiredGlyphWorkbench>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = { render: () => <InteractiveWorkbench /> };
export const Empty: Story = {};
export const Conversation: Story = { render: () => <InteractiveWorkbench /> };
export const AttachedSelection: Story = {
  args: { state: workbenchStateFixture({ transcript: conversationFixture() }), actions: attachedActionsFixture() },
};
export const Streaming: Story = {
  args: { state: workbenchStateFixture({ transcript: conversationFixture(), status: GlyphWorkbenchStatus.STREAMING }) },
};
export const SendFailure: Story = { args: { actions: failingActionsFixture() } };

const savedChat = chatFixture();
const expandTodos = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('.glyph-todos button')?.click();
};
export const Todos: Story = {
  args: {
    state: workbenchStateFixture({
      selectedChatId: savedChat.id,
      chats: [
        {
          ...savedChat,
          todos: todoItems,
        },
      ],
      transcript: conversationFixture(),
    }),
  },
  play: expandTodos,
};
export const TodosWithQueuedMessages: Story = {
  args: {
    ...Todos.args,
    state: workbenchStateFixture({ ...Todos.args?.state, status: GlyphWorkbenchStatus.STREAMING }),
    actions: previewActionsFixture({ composer: composerFixture({ queued: queuedMessageDocuments }) }),
  },
  play: expandTodos,
};
export const ComposerDrawers: Story = {
  args: {
    ...TodosWithQueuedMessages.args,
    state: workbenchStateFixture({
      ...TodosWithQueuedMessages.args?.state,
      proposals: pendingProposals.map(proposal => ({ ...proposal, chatId: savedChat.id })),
    }),
  },
  play: expandTodos,
};
const navigationState = navigationStateFixture();
const expandHistory = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')?.click();
};
export const ChatHistory: Story = {
  args: { state: { ...navigationState, selectedChatId: 'settings', transcript: conversationFixture() } },
  play: expandHistory,
};
export const NewChatSetup: Story = { args: { state: navigationState }, play: expandHistory };
const { selectedModel: _selectedModel, ...withoutModel } = navigationState;
export const LoadingModels: Story = {
  args: { state: { ...withoutModel, models: [], catalogPending: true } },
  play: expandHistory,
};
export const CatalogFailure: Story = {
  args: {
    state: { ...withoutModel, models: [], navigationError: 'Could not load models. Choose an account to retry.' },
  },
  play: expandHistory,
};

const meteredUsage = usageFixture();
export const MarkdownAndUsage: Story = {
  args: {
    state: {
      ...navigationState,
      selectedChatId: 'settings',
      models: [autoModel],
      selectedModel: 'auto',
      chats: [{ ...savedChat, modelSlug: 'auto', title: 'Message queue' }],
      usage: { settings: meteredUsage },
      transcript: [
        userMessageFixture({
          id: 'request',
          checkpointTurnId: 'markdown-answer',
          text: 'Explain how messages are queued.',
          createdAt: '2026-10-17T15:30:00Z',
        }),
        markdownMessageFixture(),
      ],
    },
  },
};
