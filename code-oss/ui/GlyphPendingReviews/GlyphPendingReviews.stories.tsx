import { ProtocolError } from '#src/errors/ProtocolError.js';
import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WiredGlyphPendingReviews } from './GlyphPendingReviews.wired.tsx';
import { GlyphProposalApplicability } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import { previewActions } from '#code-oss/storybook/fixtures.ts';

const meta = {
  title: 'Glyph/Pending reviews',
  component: WiredGlyphPendingReviews,
  args: {
    chatId: 'chat',
    readOnly: false,
    actions: previewActions,
    proposals: [
      {
        id: 'proposal',
        chatId: 'chat',
        createdAt: '',
        files: [
          {
            id: 'runtime',
            path: 'src/desktop/host/ProviderDesktopRuntime.ts',
            proposedUri: '',
            pendingItemIds: ['one'],
            applicability: GlyphProposalApplicability.READY,
            textOnly: true,
            additions: 2,
            deletions: 1,
          },
          {
            id: 'decision',
            path: 'code-oss/ui/useGlyphDecision.ts',
            proposedUri: '',
            pendingItemIds: ['two'],
            applicability: GlyphProposalApplicability.READY,
            textOnly: true,
            additions: 1,
            deletions: 2,
          },
        ],
      },
    ],
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
      ...previewActions,
      decideProposalItems: async () => {
        throw new ProtocolError('The file changed. Request a fresh proposal.');
      },
    },
  },
};
