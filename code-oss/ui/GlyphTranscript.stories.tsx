import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { GlyphTranscript } from './GlyphTranscript.tsx';
import { conversation } from '#code-oss/storybook/fixtures.ts';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';

const meta = {
  title: 'Glyph/Transcript',
  component: GlyphTranscript,
  args: { entries: conversation },
  decorators: [
    Story => (
      <div class="glyph-workbench">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GlyphTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation: Story = {};
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
