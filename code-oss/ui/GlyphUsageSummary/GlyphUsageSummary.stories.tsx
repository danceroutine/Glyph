import { usageFixture } from '#code-oss/storybook/fixtures/MessageFixtures.ts';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphUsageSummary as GlyphUsageSummary } from './GlyphUsageSummary.wired.tsx';
import { workbenchClassName } from '#code-oss/ui/GlyphWorkbench/GlyphWorkbench.presentational.tsx';

const meta = {
  title: 'Glyph/Chat/Shared/Conversation usage',
  component: GlyphUsageSummary,
  args: {
    usage: usageFixture({ unreportedTurns: 0 }),
  },
  decorators: [
    Story => (
      <div class={`glyph-workbench ${workbenchClassName}`}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GlyphUsageSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Reported: Story = {};
export const MissingHistoricalUsage: Story = { args: { usage: { ...meta.args.usage, unreportedTurns: 3 } } };
export const Unavailable: Story = { args: { usage: undefined } };
export const ReportedZero: Story = {
  args: {
    usage: usageFixture({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }),
  },
};
