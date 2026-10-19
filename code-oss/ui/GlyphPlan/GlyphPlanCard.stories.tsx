import type { Meta, StoryObj } from '@storybook/preact-vite';
import { fn } from 'storybook/test';
import { planView } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { GlyphPlanCard } from './GlyphPlanCard.presentational.tsx';

const meta = {
  title: 'Glyph/Chat/In Transcript/Plan Card',
  component: GlyphPlanCard,
  args: {
    plan: planView.plan,
    disabled: false,
    view: fn().mockName('PlanCard.view'),
    build: fn().mockName('PlanCard.build'),
    buildNew: fn().mockName('PlanCard.buildNew'),
  },
} satisfies Meta<typeof GlyphPlanCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const ReadOnly: Story = { args: { disabled: true } };
export const Narrow: Story = { globals: { paneWidth: '280' } };
