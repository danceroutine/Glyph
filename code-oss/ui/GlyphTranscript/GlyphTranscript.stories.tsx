import { useState } from 'preact/hooks';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { WiredGlyphTranscript } from './GlyphTranscript.wired.tsx';
import { workbenchClassName } from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.presentational.tsx';
import { conversation, previewActions } from '#code-oss/storybook/fixtures.ts';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';

const meta = {
  title: 'Glyph/Chat/Transcript',
  component: WiredGlyphTranscript,
  args: { entries: conversation, chatId: 'chat', actions: previewActions },
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

export const Conversation: Story = { render: () => <HistoryPreview initialEntries={conversation} /> };
export const Empty: Story = { args: { entries: [] } };
export const ReasoningAndTools: Story = {
  args: {
    entries: [
      {
        id: 'progress',
        role: GlyphTranscriptRole.ASSISTANT,
        text: 'Inspecting the project.',
        progress: {
          reasoning:
            'I will inspect the entry point, then read the relevant tests.\nThe tool results will determine the next step.',
          status: GlyphRunStatus.STREAMING,
          tools: [
            { id: 'read', name: 'read_project_file', status: GlyphToolActivityStatus.COMPLETED },
            { id: 'search', name: 'search_project', status: GlyphToolActivityStatus.STARTED },
            { id: 'failed', name: 'read_project_file', status: GlyphToolActivityStatus.FAILED },
          ],
        },
      },
    ],
  },
};
export const InterruptedProgress: Story = {
  args: {
    entries: [
      {
        id: 'interrupted',
        role: GlyphTranscriptRole.ASSISTANT,
        text: 'Partial answer before the host stopped.',
        progress: {
          reasoning: 'Inspecting the file.',
          status: GlyphRunStatus.INTERRUPTED,
          tools: [{ id: 'read', name: 'read_project_file', status: GlyphToolActivityStatus.STARTED }],
        },
      },
    ],
  },
};
export const LongConversation: Story = {
  args: {
    entries: Array.from({ length: 40 }, (_, index) => ({
      id: `long-${index}`,
      role: index % 2 === 0 ? GlyphTranscriptRole.USER : GlyphTranscriptRole.ASSISTANT,
      text: `Message ${index + 1}\n${'Long messages should wrap inside the pane and leave the transcript scrollable. '.repeat(6)}`,
    })),
  },
};

export const InlineContext: Story = {
  args: {
    actions: previewActions,
    entries: [
      {
        id: 'attachments',
        role: GlyphTranscriptRole.USER,
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
      },
    ],
  },
};

export const MarkdownAndMermaid: Story = {
  globals: { paneWidth: '600' },
  args: {
    actions: previewActions,
    entries: [
      {
        id: 'markdown-user',
        checkpointTurnId: 'markdown-answer',
        role: GlyphTranscriptRole.USER,
        text: 'Explain the queue behavior and the verification steps.',
        createdAt: '2026-10-17T15:30:00Z',
      },
      {
        id: 'markdown-answer',
        checkpointTurnId: 'markdown-answer',
        role: GlyphTranscriptRole.ASSISTANT,
        createdAt: '2026-10-17T15:30:08Z',
        usage: {
          inputTokens: 12400,
          cachedInputTokens: 8000,
          outputTokens: 650,
          reasoningTokens: 200,
          totalTokens: 13050,
        },
        text: '## Queue composer messages\n\nMessages remain **in order** while the agent works. See [GlyphComposerState.ts](src/desktop/workbench/GlyphComposerState.ts).\n\n1. Submit the next message.\n2. Check whether a run is active.\n   - Queue it when busy.\n   - Send it immediately when idle.\n\n> Preserve the original attachments and their exact revisions.\n\n```mermaid\nflowchart LR\n  Composer --> Active{Run active?}\n  Active -->|yes| Queue[Add to queue]\n  Active -->|no| Send[Send immediately]\n```\n\n### Verification\n\n| Check | Result |\n| --- | --- |\n| Message order | Passed |\n| Attachment revisions | Passed |\n\n```ts\nconst next = queue.shift();\nif (next) await send(next);\n```\n\nRun `pnpm test` before building.',
      },
    ],
  },
};

function HistoryPreview({ initialEntries }: { readonly initialEntries?: typeof conversation }) {
  const initial = [
    {
      id: 'first:user',
      checkpointTurnId: 'first',
      role: GlyphTranscriptRole.USER,
      text: 'Good, now undo both changes',
    },
    {
      id: 'first',
      checkpointTurnId: 'first',
      role: GlyphTranscriptRole.ASSISTANT,
      text: 'Both changes are reverted in [ProviderDesktopRuntime.ts](src/desktop/host/ProviderDesktopRuntime.ts) and `useGlyphDecision.ts`.',
      createdAt: '2026-10-18T14:30:00Z',
    },
    {
      id: 'second:user',
      checkpointTurnId: 'second',
      role: GlyphTranscriptRole.USER,
      text: "Make a sample plan, doesn't have to be of anything specific, just need to check the UI, add some todos in the plan",
    },
    {
      id: 'second',
      checkpointTurnId: 'second',
      role: GlyphTranscriptRole.ASSISTANT,
      text: 'Here is a sample plan for the message queue.',
    },
  ];
  const [entries, setEntries] = useState(initialEntries ?? initial);
  const [notice, setNotice] = useState('');
  return (
    <>
      <WiredGlyphTranscript
        entries={entries}
        chatId="chat"
        actions={{
          ...previewActions,
          branchChat: async (_chatId, turnId) => {
            setEntries(entries.slice(0, entries.findIndex(entry => entry.id === turnId) + 1));
            setNotice('Branched chat · the original conversation is unchanged.');
          },
          restoreCheckpoint: async (_chatId, turnId) => {
            const index = entries.findIndex(
              entry => entry.role === GlyphTranscriptRole.USER && entry.checkpointTurnId === turnId,
            );
            setNotice(`Restored checkpoint · draft: ${entries[index]!.text}`);
            setEntries(entries.slice(0, index));
          },
        }}
      />
      {notice && <p role="status">{notice}</p>}
    </>
  );
}

export const MessageActions: Story = {
  render: () => <HistoryPreview />,
};
