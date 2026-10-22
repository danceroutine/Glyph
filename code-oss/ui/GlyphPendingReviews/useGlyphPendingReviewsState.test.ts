import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import {
  GlyphProposalApplicability,
  type GlyphProposalFileSummary,
} from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import type { GlyphProposalSummary } from '#src/desktop/protocol/events/GlyphProposalSummary.js';
import { useGlyphPendingReviewsState } from '#code-oss/ui/GlyphPendingReviews/useGlyphPendingReviewsState.ts';

const proposalFile = (overrides: Partial<GlyphProposalFileSummary> = {}): GlyphProposalFileSummary => ({
  id: 'file',
  path: 'src/app.ts',
  proposedUri: 'glyph://proposal/file',
  pendingItemIds: ['item'],
  textOnly: true,
  applicability: GlyphProposalApplicability.READY,
  ...overrides,
});

const proposal = (overrides: Partial<GlyphProposalSummary> = {}): GlyphProposalSummary => ({
  id: 'proposal',
  chatId: 'chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  files: [proposalFile()],
  ...overrides,
});

const reviewActions = () => ({
  reviewProposalFile: vi.fn(async (_chatId: string, _proposalId: string, _fileId: string) => {}),
  decideProposalItems: vi.fn(
    async (_chatId: string, _items: readonly { proposalId: string; itemId: string }[], _accept: boolean) => {},
  ),
});

describe(useGlyphPendingReviewsState, () => {
  it('lists files with pending changes from proposals in this chat', () => {
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: {
        chatId: 'chat',
        readOnly: false,
        actions: reviewActions(),
        proposals: [
          proposal({
            id: 'p1',
            files: [proposalFile({ id: 'a', path: 'src/a.ts' }), proposalFile({ id: 'done', pendingItemIds: [] })],
          }),
          proposal({ id: 'other', chatId: 'elsewhere' }),
          proposal({ id: 'p2', files: [proposalFile({ id: 'b', path: 'b.ts' })] }),
        ],
      },
    });

    expect(result.current.files.map(file => [file.key, file.name, file.proposalId])).toEqual([
      ['p1/a', 'a.ts', 'p1'],
      ['p2/b', 'b.ts', 'p2'],
    ]);
    expect(result.current.summary).toBe('2 Files');
    expect(result.current.keepLabel).toBe('Keep All');
    expect(result.current.undoLabel).toBe('Revert All');
    expect(result.current.expanded).toBe(true);
    expect(result.current.busy).toBe(false);
    expect(result.current.disabled).toBe(false);
    expect(result.current.keepDisabled).toBe(false);
    expect(result.current.listId).toBeTruthy();
  });

  it('labels a single file in the singular', () => {
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: { chatId: 'chat', readOnly: false, actions: reviewActions(), proposals: [proposal()] },
    });

    expect(result.current.summary).toBe('1 File');
    expect(result.current.keepLabel).toBe('Keep');
    expect(result.current.undoLabel).toBe('Revert');
  });

  it.each([
    ['ready text edits', { textOnly: true, applicability: GlyphProposalApplicability.READY }, true],
    ['retryable text edits', { textOnly: true, applicability: GlyphProposalApplicability.FAILED_RETRYABLE }, true],
    ['ready automatic edits', { textOnly: false, autoApplied: true }, true],
    ['edits being applied', { applicability: GlyphProposalApplicability.APPLYING }, false],
    ['stale edits', { applicability: GlyphProposalApplicability.STALE }, false],
    ['file operations', { textOnly: false }, false],
  ])('decides whether %s can be kept', (_, overrides, canKeep) => {
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: {
        chatId: 'chat',
        readOnly: false,
        actions: reviewActions(),
        proposals: [proposal({ files: [proposalFile(overrides)] })],
      },
    });

    expect(result.current.files[0]?.canKeep).toBe(canKeep);
    expect(result.current.keepDisabled).toBe(!canKeep);
  });

  it('explains stale changes and file operations that could not be applied', () => {
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: {
        chatId: 'chat',
        readOnly: false,
        actions: reviewActions(),
        proposals: [
          proposal({
            files: [
              proposalFile({ id: 'stale', applicability: GlyphProposalApplicability.STALE }),
              proposalFile({ id: 'operation', textOnly: false }),
              proposalFile({ id: 'applied', textOnly: false, autoApplied: true }),
              proposalFile({ id: 'fine' }),
            ],
          }),
        ],
      },
    });

    expect(result.current.files.map(file => file.status)).toEqual([
      'File changed. Revert newer edits first, or keep this change.',
      'The file operation could not be applied. Revert to dismiss it.',
      undefined,
      undefined,
    ]);
  });

  it('is disabled in a read-only window', () => {
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: { chatId: 'chat', readOnly: true, actions: reviewActions(), proposals: [proposal()] },
    });

    expect(result.current.disabled).toBe(true);
    expect(result.current.keepDisabled).toBe(true);
  });

  it('collapses and expands the file list', () => {
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: { chatId: 'chat', readOnly: false, actions: reviewActions(), proposals: [proposal()] },
    });

    act(() => {
      result.current.toggle();
    });
    expect(result.current.expanded).toBe(false);

    act(() => {
      result.current.toggle();
    });
    expect(result.current.expanded).toBe(true);
  });

  it('keeps or reverts every pending item at once', async () => {
    const actions = reviewActions();
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: {
        chatId: 'chat',
        readOnly: false,
        actions,
        proposals: [
          proposal({ id: 'p1', files: [proposalFile({ id: 'a', pendingItemIds: ['i1', 'i2'] })] }),
          proposal({ id: 'p2', files: [proposalFile({ id: 'b', pendingItemIds: ['i3'] })] }),
        ],
      },
    });
    const items = [
      { proposalId: 'p1', itemId: 'i1' },
      { proposalId: 'p1', itemId: 'i2' },
      { proposalId: 'p2', itemId: 'i3' },
    ];

    await act(() => result.current.keep());
    await act(() => result.current.undo());

    expect(actions.decideProposalItems.mock.calls).toEqual([
      ['chat', items, true],
      ['chat', items, false],
    ]);
  });

  it('keeps, reverts and reviews individual files', async () => {
    const actions = reviewActions();
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: {
        chatId: 'chat',
        readOnly: false,
        actions,
        proposals: [
          proposal({ id: 'p1', files: [proposalFile({ id: 'a', pendingItemIds: ['i1'] })] }),
          proposal({ id: 'p2', files: [proposalFile({ id: 'b', pendingItemIds: ['i2'] })] }),
        ],
      },
    });

    await act(() => result.current.files[1]!.keep());
    await act(() => result.current.files[0]!.undo());
    await act(() => result.current.files[1]!.review());

    expect(actions.decideProposalItems.mock.calls).toEqual([
      ['chat', [{ proposalId: 'p2', itemId: 'i2' }], true],
      ['chat', [{ proposalId: 'p1', itemId: 'i1' }], false],
    ]);
    expect(actions.reviewProposalFile).toHaveBeenCalledWith('chat', 'p2', 'b');
  });

  it('reviews the first pending file', async () => {
    const actions = reviewActions();
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: {
        chatId: 'chat',
        readOnly: false,
        actions,
        proposals: [proposal({ id: 'p1', files: [proposalFile({ id: 'a' }), proposalFile({ id: 'b' })] })],
      },
    });

    await act(() => result.current.review());

    expect(actions.reviewProposalFile).toHaveBeenCalledExactlyOnceWith('chat', 'p1', 'a');
  });

  it('has nothing to review without pending files', async () => {
    const actions = reviewActions();
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: { chatId: 'chat', readOnly: false, actions, proposals: [] },
    });

    await act(() => result.current.review());

    expect(actions.reviewProposalFile).not.toHaveBeenCalled();
    expect(result.current.summary).toBe('0 Files');
  });

  it('runs one operation at a time and is busy until it settles', async () => {
    const actions = reviewActions();
    let finish!: () => void;
    actions.decideProposalItems.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: { chatId: 'chat', readOnly: false, actions, proposals: [proposal()] },
    });

    let first!: Promise<void>;
    act(() => {
      first = result.current.keep();
    });
    expect(result.current.busy).toBe(true);
    expect(result.current.disabled).toBe(true);
    expect(result.current.keepDisabled).toBe(true);

    await act(() => result.current.undo());
    expect(actions.decideProposalItems).toHaveBeenCalledOnce();

    await act(async () => {
      finish();
      await first;
    });
    expect(result.current.busy).toBe(false);
  });

  it('reports failed operations until the next attempt', async () => {
    const actions = reviewActions();
    actions.decideProposalItems.mockRejectedValueOnce(new Error('Conflict')).mockRejectedValueOnce('Refused');
    const { result } = renderHook(useGlyphPendingReviewsState, {
      initialProps: { chatId: 'chat', readOnly: false, actions, proposals: [proposal()] },
    });

    await act(() => result.current.keep());
    expect(result.current.error).toBe('Conflict');
    expect(result.current.busy).toBe(false);

    await act(() => result.current.keep());
    expect(result.current.error).toBe('Refused');

    await act(() => result.current.keep());
    expect(result.current.error).toBeUndefined();
  });
});
