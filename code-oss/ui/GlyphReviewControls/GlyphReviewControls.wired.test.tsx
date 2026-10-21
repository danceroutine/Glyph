import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WiredGlyphReviewControls } from '#code-oss/ui/GlyphReviewControls/GlyphReviewControls.wired.tsx';

afterEach(cleanup);

describe(WiredGlyphReviewControls, () => {
  it('focuses the comment field and rejects the edit with the comment', async () => {
    const rejectWithComment = vi.fn(async () => {});
    render(
      <WiredGlyphReviewControls
        label="1 of 1"
        disabled={false}
        keepDisabled={false}
        previous={vi.fn()}
        next={vi.fn()}
        keep={vi.fn(async () => {})}
        undo={vi.fn(async () => {})}
        rejectWithComment={rejectWithComment}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reject with comments' }));
    const input = screen.getByRole('textbox', { name: 'Why should this change be revised?' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.input(input, { target: { value: 'Use a map' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject with comment' }));

    await waitFor(() => expect(rejectWithComment).toHaveBeenCalledWith('Use a map'));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Rejection comment' })).toBeNull());
  });
});
