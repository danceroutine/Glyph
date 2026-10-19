import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { fn } from 'storybook/test';
import { pendingProposals } from '#code-oss/storybook/fixtures/WorkspaceFixtures.ts';
import { ProtocolError } from '#src/errors/ProtocolError.js';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphPendingReviews } from './GlyphPendingReviews.wired.tsx';

import { previewActionsFixture } from '#code-oss/storybook/fixtures/ActionFixtures.ts';

const meta = {
  title: 'Glyph/Chat/In Composer/Pending reviews',
  component: WiredGlyphPendingReviews,
  args: {
    chatId: 'chat',
    readOnly: false,
    actions: previewActionsFixture(),
    proposals: pendingProposals,
  },
} satisfies Meta<typeof WiredGlyphPendingReviews>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MultipleFiles: Story = {};
export const SingleFile: Story = {
  args: { proposals: [{ ...meta.args.proposals[0]!, files: [meta.args.proposals[0]!.files[0]!] }] },
};
export const ReadOnly: Story = { args: { readOnly: true } };
export const FailedDecision: Story = {
  args: {
    actions: {
      ...previewActionsFixture(),
      decideProposalItems: fn<NonNullable<GlyphWorkbenchViewActions['decideProposalItems']>>(async () => {
        throw new ProtocolError('The file changed. Request a fresh proposal.');
      }).mockName('GlyphPendingReviews.decideProposalItems'),
    },
  },
};
