import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphReviewCommand } from '#src/desktop/workbench/GlyphReviewCommand.js';
import { GlyphReviewControls } from '#code-oss/ui/GlyphReviewControls/GlyphReviewControls.presentational.tsx';
import type { GlyphReviewControlsState } from '#code-oss/ui/GlyphReviewControls/useGlyphReviewControlsState.ts';

afterEach(cleanup);

const controlsState = (overrides: Partial<GlyphReviewControlsState> = {}): GlyphReviewControlsState => ({
  label: '1 of 3',
  disabled: false,
  keepDisabled: false,
  keepAllDisabled: false,
  navigationDisabled: false,
  previous: vi.fn(),
  next: vi.fn(),
  previousFile: undefined,
  nextFile: undefined,
  keep: vi.fn(async () => {}),
  undo: vi.fn(async () => {}),
  keepFile: undefined,
  undoFile: undefined,
  keepAll: undefined,
  error: undefined,
  commentOpen: false,
  comment: '',
  commentInput: createRef<HTMLTextAreaElement>(),
  setComment: vi.fn(),
  openComment: vi.fn(),
  cancelComment: vi.fn(),
  commentDisabled: true,
  commentPending: false,
  submitComment: vi.fn(async () => {}),
  ...overrides,
});

describe(GlyphReviewControls, () => {
  it('reviews an edit with change navigation, revert and keep', () => {
    const state = controlsState();
    render(<GlyphReviewControls {...state} />);

    expect(screen.getByRole('region', { name: 'Edit review controls' })).toBeTruthy();
    expect(screen.getByText('1 of 3')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reject with comments' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Previous file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review Next File' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep all changes' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Previous change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));

    expect(state.previous).toHaveBeenCalledOnce();
    expect(state.next).toHaveBeenCalledOnce();
    expect(state.undo).toHaveBeenCalledOnce();
    expect(state.keep).toHaveBeenCalledOnce();
  });

  it('labels actions with their keyboard shortcuts', () => {
    render(
      <GlyphReviewControls
        {...controlsState({
          rejectWithComment: vi.fn(async () => {}),
          undoFile: vi.fn(async () => {}),
          keepFile: vi.fn(async () => {}),
          keepAll: vi.fn(async () => {}),
          shortcuts: {
            [GlyphReviewCommand.UNDO]: '⌘N',
            [GlyphReviewCommand.KEEP]: '⌘Y',
            [GlyphReviewCommand.COMMENT]: '⌘M',
            [GlyphReviewCommand.UNDO_FILE]: '⇧⌘N',
            [GlyphReviewCommand.KEEP_FILE]: '⇧⌘Y',
            [GlyphReviewCommand.KEEP_ALL]: '⌥⌘Y',
          },
        })}
      />,
    );

    expect(
      ['Revert', 'Keep', 'Reject with comments', 'Revert File', 'Keep File', 'Keep all changes'].map(
        name => screen.getByRole('button', { name }).querySelector('kbd')?.textContent,
      ),
    ).toEqual(['⌘N', '⌘Y', '⌘M', '⇧⌘N', '⇧⌘Y', '⌥⌘Y']);
  });

  it('offers rejecting an edit with comments', () => {
    const state = controlsState({ rejectWithComment: vi.fn(async () => {}) });
    render(<GlyphReviewControls {...state} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reject with comments' }));

    expect(state.openComment).toHaveBeenCalledOnce();
  });

  it('reviews a file with file navigation and file-wide actions', () => {
    const state = controlsState({
      fileLabel: 'app.ts',
      previousFile: vi.fn(async () => {}),
      nextFile: vi.fn(async () => {}),
      undoFile: vi.fn(async () => {}),
      keepFile: vi.fn(async () => {}),
      keepAll: vi.fn(async () => {}),
      rejectWithComment: vi.fn(async () => {}),
    });
    render(<GlyphReviewControls {...state} />);

    expect(screen.getByRole('region', { name: 'File review controls' })).toBeTruthy();
    expect(screen.getByText('app.ts')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revert' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject with comments' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Previous file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review Next File' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revert File' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep File' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep all changes' }));

    expect(state.previousFile).toHaveBeenCalledOnce();
    expect(state.nextFile).toHaveBeenCalledOnce();
    expect(state.undoFile).toHaveBeenCalledOnce();
    expect(state.keepFile).toHaveBeenCalledOnce();
    expect(state.keepAll).toHaveBeenCalledOnce();
  });

  it('offers only moving on and keeping everything once a file is reviewed', () => {
    const state = controlsState({
      fileLabel: 'app.ts',
      fileComplete: true,
      nextFile: vi.fn(async () => {}),
      keepAll: vi.fn(async () => {}),
      shortcuts: { [GlyphReviewCommand.NEXT_FILE]: '⌘]' },
    });
    render(<GlyphReviewControls {...state} />);

    expect(screen.queryByRole('button', { name: 'Next change' })).toBeNull();
    const next = screen.getByRole('button', { name: 'Review Next File' });
    expect(next.textContent).toContain('Review Next File');
    expect(next.querySelector('kbd')?.textContent).toBe('⌘]');

    fireEvent.click(next);

    expect(state.nextFile).toHaveBeenCalledOnce();
  });

  it('offers nothing for a reviewed file without a next file or remaining changes', () => {
    render(<GlyphReviewControls {...controlsState({ fileLabel: 'app.ts', fileComplete: true })} />);

    expect(screen.getByRole('region', { name: 'File review controls' }).querySelectorAll('button')).toHaveLength(0);
  });

  it('renders nothing for a completed edit review', () => {
    const { container } = render(<GlyphReviewControls {...controlsState({ fileComplete: true })} />);

    expect(container.innerHTML).toBe('');
  });

  it('disables actions while unavailable', () => {
    render(
      <GlyphReviewControls
        {...controlsState({
          disabled: true,
          keepDisabled: true,
          keepAllDisabled: true,
          navigationDisabled: true,
          rejectWithComment: vi.fn(async () => {}),
          previousFile: vi.fn(async () => {}),
          nextFile: vi.fn(async () => {}),
          undoFile: vi.fn(async () => {}),
          keepFile: vi.fn(async () => {}),
          keepAll: vi.fn(async () => {}),
        })}
      />,
    );

    expect(screen.getAllByRole('button').every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('shortens the keep all label when the full controls do not fit', async () => {
    const { container } = render(
      <div style={{ width: '120px' }}>
        <GlyphReviewControls
          {...controlsState({ fileLabel: 'a-rather-long-file-name.ts', keepAll: vi.fn(async () => {}) })}
        />
      </div>,
    );

    const suffix = container.querySelector<HTMLElement>('[data-keep-all-suffix]')!;
    await waitFor(() => expect(suffix.hidden).toBe(true));
    expect(container.querySelectorAll('[data-keep-all-suffix]')).toHaveLength(1);
  });

  it('shows the full keep all label when the controls fit', async () => {
    const { container } = render(
      <div style={{ width: '2000px' }}>
        <GlyphReviewControls {...controlsState({ fileLabel: 'app.ts', keepAll: vi.fn(async () => {}) })} />
      </div>,
    );

    await waitFor(() => expect(container.querySelector<HTMLElement>('[data-keep-all-suffix]')!.hidden).toBe(false));
  });

  it('measures file controls without a keep all action', () => {
    const { container } = render(
      <div style={{ width: '2000px' }}>
        <GlyphReviewControls {...controlsState({ fileLabel: 'app.ts' })} />
      </div>,
    );

    expect(container.querySelectorAll('section > div')).toHaveLength(1);
  });

  it('collects a rejection comment', () => {
    const state = controlsState({ commentOpen: true, comment: 'Use a map', commentDisabled: false });
    render(<GlyphReviewControls {...state} />);
    const input = screen.getByRole('textbox', { name: 'Why should this change be revised?' }) as HTMLTextAreaElement;
    expect(input.value).toBe('Use a map');
    expect(state.commentInput.current).toBe(input);

    fireEvent.input(input, { target: { value: 'Use a set' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject with comment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(state.setComment).toHaveBeenCalledWith('Use a set');
    expect(state.submitComment).toHaveBeenCalledOnce();
    expect(state.cancelComment).toHaveBeenCalledOnce();
  });

  it('submits a comment with Enter and cancels it with Escape', () => {
    const state = controlsState({ commentOpen: true, comment: 'Revise', commentDisabled: false });
    render(<GlyphReviewControls {...state} />);
    const input = screen.getByRole('textbox', { name: 'Why should this change be revised?' });

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'a' });
    expect(state.submitComment).not.toHaveBeenCalled();
    expect(state.cancelComment).not.toHaveBeenCalled();

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(escape);

    expect(enter.defaultPrevented).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    expect(state.submitComment).toHaveBeenCalledOnce();
    expect(state.cancelComment).toHaveBeenCalledOnce();
  });

  it('locks the comment while it is being submitted', () => {
    render(<GlyphReviewControls {...controlsState({ commentOpen: true, commentPending: true })} />);

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject with comment' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows why the last action failed', () => {
    render(<GlyphReviewControls {...controlsState({ error: 'Conflict' })} />);

    expect(screen.getByRole('alert').textContent).toBe('Conflict');
  });
});
