import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { fn } from 'storybook/test';
import {
  userMessageFixture,
  messageActionsConversation,
  longConversationFixture,
  conversationFixture,
  planBuildConversationFixture,
  planBuildFixture,
} from '#code-oss/storybook/fixtures/MessageFixtures.ts';

import { useState } from 'preact/hooks';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { WiredGlyphTranscript, type WiredGlyphTranscriptProps } from './GlyphTranscript.wired.tsx';
import { workbenchClassName } from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.presentational.tsx';

import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';

const meta = {
  title: 'Glyph/Chat/In Transcript/Chat History',
  component: WiredGlyphTranscript,
  args: { entries: conversationFixture(), chatId: 'chat', actions: previewActionsFixture() },
  decorators: [
    Story => (
      <div class={`glyph-workbench ${workbenchClassName}`}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WiredGlyphTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = { render: () => <HistoryPreview initialEntries={conversationFixture()} /> };
export const Empty: Story = { args: { entries: [] } };
export const LongConversation: Story = {
  args: {
    entries: longConversationFixture(),
  },
};

export const InlineContext: Story = {
  args: {
    actions: previewActionsFixture(),
    entries: [
      userMessageFixture({
        id: 'attachments',
        text: 'Compare @src/greeting.ts (11-12) with @src/other.ts please.',
        attachments: [
          {
            path: 'src/greeting.ts',
            text: 'Captured selection',
            revision: '1',
            range: { start: { line: 11, column: 1 }, end: { line: 12, column: 1 } },
          },
          { path: 'src/other.ts', text: 'Captured file', revision: '2' },
        ],
      }),
    ],
  },
};

function HistoryPreview({ initialEntries }: { readonly initialEntries?: ReturnType<typeof conversationFixture> }) {
  const initial = messageActionsConversation;
  const [entries, setEntries] = useState(initialEntries ?? initial);
  const [notice, setNotice] = useState('');
  return (
    <>
      <WiredGlyphTranscript
        entries={entries}
        chatId="chat"
        actions={{
          ...previewActionsFixture(),
          branchChat: fn<NonNullable<GlyphWorkbenchViewActions['branchChat']>>(async (_chatId, turnId) => {
            setEntries(entries.slice(0, entries.findIndex(entry => entry.id === turnId) + 1));
            setNotice('Branched chat · the original conversation is unchanged.');
          }).mockName('GlyphTranscript.branchChat'),
          restoreCheckpoint: fn<NonNullable<GlyphWorkbenchViewActions['restoreCheckpoint']>>(
            async (_chatId, turnId) => {
              const index = entries.findIndex(
                entry => entry.role === GlyphTranscriptRole.USER && entry.checkpointTurnId === turnId,
              );
              setNotice(`Restored checkpoint · draft: ${entries[index]!.text}`);
              setEntries(entries.slice(0, index));
            },
          ).mockName('GlyphTranscript.restoreCheckpoint'),
        }}
      />
      {notice && <p role="status">{notice}</p>}
    </>
  );
}

export const MessageActions: Story = {
  render: () => <HistoryPreview />,
};

export const PlanBuildOrder: Story = {
  args: {
    entries: planBuildConversationFixture(),
    openPlan: fn<NonNullable<WiredGlyphTranscriptProps['openPlan']>>().mockName('GlyphTranscript.openPlan'),
  },
};

export const PlanBuilding: Story = {
  args: {
    entries: planBuildConversationFixture(),
    buildingPlanIds: [planBuildFixture.planId],
    openPlan: fn<NonNullable<WiredGlyphTranscriptProps['openPlan']>>().mockName('GlyphTranscript.openPlan'),
  },
  decorators: [
    Story => (
      <div style={{ height: 420, display: 'flex', flexDirection: 'column' }}>
        <Story />
      </div>
    ),
  ],
};
