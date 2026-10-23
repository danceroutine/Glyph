import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { fn } from 'storybook/test';
import { goalFixture } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';
import { ProtocolError } from '#src/errors/ProtocolError.js';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphGoalRow } from './GlyphGoalRow.wired.tsx';

const meta = {
  title: 'Glyph/Chat/In Composer/Goal',
  component: WiredGlyphGoalRow,
  args: {
    chatId: 'chat',
    readOnly: false,
    actions: previewActionsFixture(),
    goal: goalFixture(),
  },
} satisfies Meta<typeof WiredGlyphGoalRow>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Active: Story = { args: { goal: goalFixture({ activeSince: new Date().toISOString() }) } };
export const PausedByUser: Story = { args: { goal: goalFixture({ status: 'paused', pauseReason: 'user' }) } };
export const PausedWithoutProgress: Story = {
  args: { goal: goalFixture({ status: 'paused', pauseReason: 'stalled', idleContinuationsWithoutToolCalls: 3 }) },
};
export const PausedAfterFailure: Story = { args: { goal: goalFixture({ status: 'paused', pauseReason: 'failed' }) } };
export const Complete: Story = { args: { goal: goalFixture({ status: 'complete', activeDurationMs: 3_725_000 }) } };
export const LongObjective: Story = {
  args: {
    goal: goalFixture({
      objective:
        'Make pnpm test run every suite in the repository, enforce 100% coverage across src, code-oss/ui, code-oss/overlay and scripts, and keep the Electron suite under two hours',
    }),
  },
};
export const ReadOnly: Story = { args: { readOnly: true } };
export const FailedAction: Story = {
  args: {
    actions: {
      ...previewActionsFixture(),
      pauseGoal: fn<NonNullable<GlyphWorkbenchViewActions['pauseGoal']>>(async () => {
        throw new ProtocolError('This goal is no longer current.');
      }).mockName('GlyphGoalRow.pauseGoal'),
    },
  },
};
