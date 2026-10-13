import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { GlyphTranscript } from './GlyphTranscript.tsx';
import { conversation } from '#code-oss/storybook/fixtures.ts';

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
export const LongConversation: Story = {
  args: {
    entries: Array.from({ length: 40 }, (_, index) => ({
      id: `long-${index}`,
      role: index % 2 === 0 ? GlyphTranscriptRole.USER : GlyphTranscriptRole.ASSISTANT,
      text: `Message ${index + 1}\n${'Long messages should wrap inside the pane and leave the transcript scrollable. '.repeat(6)}`,
    })),
  },
};
