import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphProposalApplicability } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import { WiredGlyphPendingReviews } from '#code-oss/ui/GlyphPendingReviews/GlyphPendingReviews.wired.tsx';

afterEach(cleanup);

describe(WiredGlyphPendingReviews, () => {
  it('keeps the pending files of the chat through the host', async () => {
    const decideProposalItems = vi.fn(async () => {});
    render(
      <WiredGlyphPendingReviews
        chatId="chat"
        readOnly={false}
        actions={{ reviewProposalFile: vi.fn(async () => {}), decideProposalItems }}
        proposals={[
          {
            id: 'proposal',
            chatId: 'chat',
            createdAt: '2026-01-01T00:00:00.000Z',
            files: [
              {
                id: 'file',
                path: 'src/app.ts',
                proposedUri: 'glyph://proposal/file',
                pendingItemIds: ['item'],
                textOnly: true,
                applicability: GlyphProposalApplicability.READY,
              },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));

    await waitFor(() => {
      expect(decideProposalItems).toHaveBeenCalledWith('chat', [{ proposalId: 'proposal', itemId: 'item' }], true);
    });
  });
});
