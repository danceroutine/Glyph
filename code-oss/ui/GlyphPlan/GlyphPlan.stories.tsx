import { planView, planActions } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphPlan } from './GlyphPlan.wired.tsx';
const meta = {
  title: 'Glyph/Editor/Plan',
  component: WiredGlyphPlan,
  args: {
    state: planView,
    actions: planActions,
  },
  globals: { paneWidth: '1000' },
  parameters: { layout: 'fullscreen' },
  decorators: [
    Story => (
      <div style={{ height: 'calc(100vh - 34px)' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WiredGlyphPlan>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Document: Story = {};
export const ReadOnly: Story = { args: { state: { ...meta.args.state, disabled: true } } };
export const Building: Story = { args: { state: { ...meta.args.state, building: true } } };

export const Narrow: Story = { globals: { paneWidth: '360' } };
