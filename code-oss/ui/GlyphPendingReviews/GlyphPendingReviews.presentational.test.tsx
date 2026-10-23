import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphProposalApplicability } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import { GlyphPendingReviews } from '#code-oss/ui/GlyphPendingReviews/GlyphPendingReviews.presentational.tsx';
import type { GlyphPendingReviewsState } from '#code-oss/ui/GlyphPendingReviews/useGlyphPendingReviewsState.ts';

afterEach(cleanup);

type ReviewFile = GlyphPendingReviewsState['files'][number];

const reviewFile = (overrides: Partial<ReviewFile> = {}): ReviewFile => ({
  id: 'file',
  path: 'src/app.ts',
  proposedUri: 'glyph://proposal/file',
  pendingItemIds: ['item'],
  applicability: GlyphProposalApplicability.READY,
  proposalId: 'proposal',
  key: 'proposal/file',
  name: 'app.ts',
  canKeep: true,
  status: undefined,
  review: vi.fn(async () => {}),
  keep: vi.fn(async () => {}),
  undo: vi.fn(async () => {}),
  ...overrides,
});

const reviewsState = (overrides: Partial<GlyphPendingReviewsState> = {}): GlyphPendingReviewsState => ({
  files: [reviewFile()],
  expanded: true,
  listId: 'pending-files',
  error: undefined,
  busy: false,
  disabled: false,
  keepDisabled: false,
  summary: '1 File',
  keepLabel: 'Keep',
  undoLabel: 'Revert',
  toggle: vi.fn(),
  keep: vi.fn(async () => {}),
  undo: vi.fn(async () => {}),
  review: vi.fn(async () => {}),
  ...overrides,
});

describe(GlyphPendingReviews, () => {
  it('summarizes the pending files with actions for all of them', () => {
    const state = reviewsState();
    render(<GlyphPendingReviews {...state} />);

    const section = screen.getByRole('region', { name: 'Pending reviews' });
    expect(section.getAttribute('aria-busy')).toBe('false');
    const toggle = screen.getByRole('button', { name: '1 File' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('pending-files');

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));

    expect(state.toggle).toHaveBeenCalledOnce();
    expect(state.undo).toHaveBeenCalledOnce();
    expect(state.keep).toHaveBeenCalledOnce();
    expect(state.review).toHaveBeenCalledOnce();
  });

  it('lists each file with its line counts and actions', () => {
    const file = reviewFile({ additions: 3, deletions: 2 });
    render(<GlyphPendingReviews {...reviewsState({ files: [file] })} />);

    const row = screen.getByRole('button', { name: 'Review src/app.ts' });
    expect(row.getAttribute('title')).toBe('src/app.ts');
    expect(row.textContent).toBe('app.ts+3−2');
    expect((row.querySelector('span:not([aria-hidden])') as HTMLElement).style.textDecoration).toBe('');
    expect(screen.getByRole('list').id).toBe('pending-files');

    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: 'Revert src/app.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep src/app.ts' }));

    expect(file.review).toHaveBeenCalledOnce();
    expect(file.undo).toHaveBeenCalledOnce();
    expect(file.keep).toHaveBeenCalledOnce();
  });

  it('shows zero line counts when they are unknown', () => {
    render(<GlyphPendingReviews {...reviewsState()} />);

    expect(screen.getByRole('button', { name: 'Review src/app.ts' }).textContent).toBe('app.ts+0−0');
  });

  it('strikes through deleted files and badges renamed files', () => {
    render(
      <GlyphPendingReviews
        {...reviewsState({
          files: [
            reviewFile({ key: 'a', path: 'old.ts', name: 'old.ts', operation: 'DELETE' }),
            reviewFile({ key: 'b', path: 'moved.ts', name: 'moved.ts', operation: 'RENAME' }),
          ],
        })}
      />,
    );

    expect(screen.getByText('old.ts').style.textDecoration).toBe('line-through');
    expect(
      screen.getByRole('button', { name: 'Review moved.ts' }).querySelector('[aria-label="Renamed"]'),
    ).toBeTruthy();
  });

  it('offers only reverting a change that was applied automatically', () => {
    render(<GlyphPendingReviews {...reviewsState({ files: [reviewFile({ autoApplied: true })] })} />);

    expect(screen.getByRole('button', { name: 'Revert src/app.ts' }).querySelector('.lucide-undo-2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep src/app.ts' })).toBeNull();
  });

  it('prevents keeping a file that cannot be kept and explains why', () => {
    render(
      <GlyphPendingReviews {...reviewsState({ files: [reviewFile({ canKeep: false, status: 'File changed.' })] })} />,
    );

    const keep = screen.getByRole('button', { name: 'Keep src/app.ts' }) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    expect(keep.getAttribute('title')).toBe('Apply proposed changes');
    expect(screen.getByRole('status').textContent).toBe('File changed.');
  });

  it('disables every action while unavailable', () => {
    render(<GlyphPendingReviews {...reviewsState({ busy: true, disabled: true, keepDisabled: true })} />);

    expect(screen.getByRole('region', { name: 'Pending reviews' }).getAttribute('aria-busy')).toBe('true');
    for (const name of ['Revert', 'Keep', 'Review', 'Review src/app.ts', 'Revert src/app.ts', 'Keep src/app.ts'])
      expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '1 File' }).disabled).toBe(false);
  });

  it('hides the file list while collapsed', () => {
    const { container } = render(<GlyphPendingReviews {...reviewsState({ expanded: false })} />);

    expect(screen.getByRole('button', { name: '1 File' }).getAttribute('aria-expanded')).toBe('false');
    const reveal = container.querySelector('[aria-hidden="true"][inert]');
    expect(reveal?.contains(container.querySelector('ul'))).toBe(true);
  });

  it('shows why the last operation failed', () => {
    render(<GlyphPendingReviews {...reviewsState({ error: 'Conflict' })} />);

    expect(screen.getByRole('alert').textContent).toBe('Conflict');
  });
});
