import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphContextBadge } from './GlyphContextBadge.presentational.tsx';

const meta = {
  title: 'Glyph/Context Badge',
  component: GlyphContextBadge,
  args: { label: 'ProviderDesktopRuntime.ts', title: 'src/desktop/host/ProviderDesktopRuntime.ts' },
} satisfies Meta<typeof GlyphContextBadge>;
export default meta;
type Story = StoryObj<typeof meta>;
export const File: Story = {};
export const Selection: Story = { args: { label: 'Untitled-1 (11-14)', title: 'Untitled-1 (11-14)' } };
/** Visual vocabulary only; skill discovery and activation belong to rank 21. */
export const Skill: Story = { args: { label: 'agent-driven-pr', title: 'agent-driven-pr', skill: true } };
export const MixedPrompt: Story = {
  render: () => (
    <div>
      Review <GlyphContextBadge label="cursor-ide-tools.md" title="docs/cursor-ide-tools.md" /> using{' '}
      <GlyphContextBadge label="agent-driven-pr" title="agent-driven-pr" skill /> and compare{' '}
      <GlyphContextBadge label="Untitled-1 (11-14)" title="Untitled-1 (11-14)" /> with the saved version.
    </div>
  ),
};
