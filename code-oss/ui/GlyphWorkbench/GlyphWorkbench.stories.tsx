import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphWorkbenchStatus } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import { WiredGlyphWorkbench } from './GlyphWorkbench.wired.tsx';
import { InteractiveWorkbench } from '#code-oss/storybook/InteractiveWorkbench.tsx';
import {
  conversation,
  failingActions,
  previewActions,
  attachedActions,
  workbenchState,
} from '#code-oss/storybook/fixtures.ts';

const meta = {
  title: 'Glyph/Workbench',
  component: WiredGlyphWorkbench,
  args: { state: workbenchState(), actions: previewActions },
  argTypes: { actions: { control: false } },
} satisfies Meta<typeof WiredGlyphWorkbench>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = { render: () => <InteractiveWorkbench /> };
export const Empty: Story = {};
export const Conversation: Story = { args: { state: workbenchState({ transcript: conversation }) } };
export const AttachedSelection: Story = {
  args: { state: workbenchState({ transcript: conversation }), actions: attachedActions },
};
export const Streaming: Story = {
  args: { state: workbenchState({ transcript: conversation, status: GlyphWorkbenchStatus.STREAMING }) },
};
export const SendFailure: Story = { args: { actions: failingActions } };

const savedChat = {
  id: 'settings',
  title: 'Review the settings migration',
  accountProvider: 'fixture',
  accountId: 'personal',
  modelSlug: 'balanced',
  updatedAt: new Date().toISOString(),
  turnCount: 4,
};
export const Todos: Story = {
  args: {
    state: workbenchState({
      selectedChatId: savedChat.id,
      chats: [
        {
          ...savedChat,
          todos: [
            { id: 'inspect', text: 'Inspect the current implementation', status: 'completed' },
            { id: 'implement', text: 'Implement the requested change', status: 'in_progress' },
            { id: 'verify', text: 'Verify persistence and chat isolation', status: 'pending' },
          ],
        },
      ],
      transcript: conversation,
    }),
  },
  play: async ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>('.glyph-todos button')?.click();
  },
};
const navigationState = workbenchState({
  accounts: [
    { provider: 'fixture', id: 'personal', label: 'developer@example.invalid', connected: true, inferenceAccess: true },
  ],
  models: [
    { slug: 'balanced', name: 'Balanced' },
    { slug: 'deep', name: 'Deep reasoning' },
  ],
  selectedAccount: { provider: 'fixture', id: 'personal' },
  selectedModel: 'balanced',
  chats: [
    savedChat,
    {
      ...savedChat,
      id: 'rendering',
      title: 'Investigate rendering performance',
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    },
  ],
});
const expandHistory = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  canvasElement.querySelector<HTMLButtonElement>('button[aria-label="Chat history"]')?.click();
};
export const ChatHistory: Story = {
  args: { state: { ...navigationState, selectedChatId: 'settings', transcript: conversation } },
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
