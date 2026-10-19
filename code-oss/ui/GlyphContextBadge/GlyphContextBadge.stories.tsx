import { fn } from 'storybook/test';
import { contextBadges } from '#code-oss/storybook/fixtures/ViewFixtures.ts';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { GlyphContextBadge } from './GlyphContextBadge.presentational.tsx';

const meta = {
  title: 'Glyph/Chat/Shared/Context Badge',
  component: GlyphContextBadge,
  args: { ...contextBadges.file, onClick: fn().mockName('ContextBadge.open') },
} satisfies Meta<typeof GlyphContextBadge>;
export default meta;
type Story = StoryObj<typeof meta>;
export const File: Story = {};
export const Selection: Story = { args: contextBadges.selection };
/** Visual vocabulary only; skill discovery and activation belong to rank 21. */
export const Skill: Story = { args: contextBadges.skill };
export const MixedPrompt: Story = {
  render: () => (
    <div>
      Review <GlyphContextBadge {...contextBadges.document} onClick={fn().mockName('ContextBadge.document')} /> using{' '}
      <GlyphContextBadge {...contextBadges.skill} onClick={fn().mockName('ContextBadge.skill')} /> and compare{' '}
      <GlyphContextBadge {...contextBadges.selection} onClick={fn().mockName('ContextBadge.selection')} /> with the
      saved version.
    </div>
  ),
};
