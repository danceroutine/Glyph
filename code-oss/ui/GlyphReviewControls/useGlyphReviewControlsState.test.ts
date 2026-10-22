import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { GlyphReviewCommand } from '#src/desktop/workbench/GlyphReviewCommand.js';
import type { GlyphReviewControls } from '#src/desktop/workbench/GlyphReviewControls.js';
import { useGlyphReviewControlsState } from '#code-oss/ui/GlyphReviewControls/useGlyphReviewControlsState.ts';

const reviewControls = (overrides: Partial<GlyphReviewControls> = {}) => ({
  label: '1 of 3',
  disabled: false,
  keepDisabled: false,
  previous: vi.fn(),
  next: vi.fn(),
  keep: vi.fn(async () => {}),
  undo: vi.fn(async () => {}),
  ...overrides,
});

const commandRegistry = () => {
  const registry = {
    handler: undefined as ((command: GlyphReviewCommand) => void) | undefined,
    dispose: vi.fn(),
    registerCommands: vi.fn((handler: (command: GlyphReviewCommand) => void) => {
      registry.handler = handler;
      return registry.dispose;
    }),
  };
  return registry;
};

describe(useGlyphReviewControlsState, () => {
  it('passes the controls through with nothing pending', () => {
    const controls = reviewControls({ fileLabel: 'app.ts', keepAllDisabled: false, navigationDisabled: false });

    const { result } = renderHook(useGlyphReviewControlsState, { initialProps: controls });

    expect(result.current.label).toBe('1 of 3');
    expect(result.current.fileLabel).toBe('app.ts');
    expect(result.current.disabled).toBe(false);
    expect(result.current.keepDisabled).toBe(false);
    expect(result.current.keepAllDisabled).toBe(false);
    expect(result.current.navigationDisabled).toBe(false);
    expect(result.current.commentOpen).toBe(false);
    expect(result.current.commentPending).toBe(false);
    expect(result.current.commentDisabled).toBe(true);
    expect(result.current.error).toBeUndefined();
    expect(result.current.previousFile).toBeUndefined();
    expect(result.current.nextFile).toBeUndefined();
    expect(result.current.keepFile).toBeUndefined();
    expect(result.current.undoFile).toBeUndefined();
    expect(result.current.keepAll).toBeUndefined();
  });

  it('runs every review action through the host', async () => {
    const controls = reviewControls({
      previousFile: vi.fn(async () => {}),
      nextFile: vi.fn(async () => {}),
      keepFile: vi.fn(async () => {}),
      undoFile: vi.fn(async () => {}),
      keepAll: vi.fn(async () => {}),
    });
    const { result } = renderHook(useGlyphReviewControlsState, { initialProps: controls });

    await act(() => result.current.keep());
    await act(() => result.current.undo());
    await act(() => result.current.previousFile!());
    await act(() => result.current.nextFile!());
    await act(() => result.current.keepFile!());
    await act(() => result.current.undoFile!());
    await act(() => result.current.keepAll!());

    for (const action of [
      controls.keep,
      controls.undo,
      controls.previousFile,
      controls.nextFile,
      controls.keepFile,
      controls.undoFile,
      controls.keepAll,
    ])
      expect(action).toHaveBeenCalledOnce();
  });

  it('disables actions and ignores more while one is pending', async () => {
    let finish!: () => void;
    const controls = reviewControls({
      keep: vi.fn(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      ),
    });
    const { result } = renderHook(useGlyphReviewControlsState, { initialProps: controls });

    let first!: Promise<void>;
    act(() => {
      first = result.current.keep();
    });
    expect(result.current.disabled).toBe(true);
    expect(result.current.keepDisabled).toBe(true);
    expect(result.current.keepAllDisabled).toBe(true);
    expect(result.current.navigationDisabled).toBe(true);
    expect(result.current.commentPending).toBe(true);

    await act(() => result.current.undo());
    expect(controls.undo).not.toHaveBeenCalled();

    await act(async () => {
      finish();
      await first;
    });
    expect(result.current.disabled).toBe(false);
  });

  it('reports failed actions until the next attempt', async () => {
    const controls = reviewControls({
      keep: vi
        .fn()
        .mockRejectedValueOnce(new Error('Conflict'))
        .mockRejectedValueOnce('Refused')
        .mockResolvedValue(undefined),
    });
    const { result } = renderHook(useGlyphReviewControlsState, { initialProps: controls });

    await act(() => result.current.keep());
    expect(result.current.error).toBe('Conflict');

    await act(() => result.current.keep());
    expect(result.current.error).toBe('Refused');

    await act(() => result.current.keep());
    expect(result.current.error).toBeUndefined();
  });

  it('collects a rejection comment and submits it as written', async () => {
    const rejectWithComment = vi.fn(async (_comment: string) => {});
    const { result } = renderHook(useGlyphReviewControlsState, {
      initialProps: reviewControls({ rejectWithComment }),
    });

    act(() => {
      result.current.openComment();
    });
    expect(result.current.commentOpen).toBe(true);
    expect(result.current.disabled).toBe(true);
    expect(result.current.keepDisabled).toBe(true);
    expect(result.current.keepAllDisabled).toBe(true);
    expect(result.current.navigationDisabled).toBe(true);

    act(() => {
      result.current.setComment(' Use a map ');
    });
    expect(result.current.commentDisabled).toBe(false);

    await act(() => result.current.submitComment());

    expect(rejectWithComment).toHaveBeenCalledWith(' Use a map ');
    expect(result.current.commentOpen).toBe(false);
    expect(result.current.comment).toBe('');
  });

  it('does not submit a blank comment', async () => {
    const rejectWithComment = vi.fn(async (_comment: string) => {});
    const { result } = renderHook(useGlyphReviewControlsState, {
      initialProps: reviewControls({ rejectWithComment }),
    });
    act(() => {
      result.current.openComment();
    });
    act(() => {
      result.current.setComment('   ');
    });

    await act(() => result.current.submitComment());

    expect(result.current.commentDisabled).toBe(true);
    expect(rejectWithComment).not.toHaveBeenCalled();
    expect(result.current.commentOpen).toBe(true);
  });

  it('cannot comment when comments are unsupported or the controls are disabled', async () => {
    const unsupported = renderHook(useGlyphReviewControlsState, { initialProps: reviewControls() });
    const rejectWithComment = vi.fn(async (_comment: string) => {});
    const disabled = renderHook(useGlyphReviewControlsState, {
      initialProps: reviewControls({ disabled: true, rejectWithComment }),
    });

    act(() => {
      unsupported.result.current.openComment();
    });
    act(() => {
      disabled.result.current.openComment();
    });
    act(() => {
      unsupported.result.current.setComment('Text');
    });
    act(() => {
      disabled.result.current.setComment('Text');
    });
    await act(() => unsupported.result.current.submitComment());
    await act(() => disabled.result.current.submitComment());

    expect(unsupported.result.current.commentOpen).toBe(false);
    expect(disabled.result.current.commentOpen).toBe(false);
    expect(disabled.result.current.commentDisabled).toBe(true);
    expect(rejectWithComment).not.toHaveBeenCalled();
  });

  it('cancels a comment unless it is being submitted', async () => {
    let finish!: () => void;
    const rejectWithComment = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(useGlyphReviewControlsState, {
      initialProps: reviewControls({ rejectWithComment }),
    });
    act(() => {
      result.current.openComment();
    });
    act(() => {
      result.current.cancelComment();
    });
    expect(result.current.commentOpen).toBe(false);

    act(() => {
      result.current.openComment();
    });
    act(() => {
      result.current.setComment('Revise');
    });
    let submission!: Promise<void>;
    act(() => {
      submission = result.current.submitComment();
    });
    act(() => {
      result.current.openComment();
    });
    act(() => {
      result.current.cancelComment();
    });
    expect(result.current.commentOpen).toBe(true);

    await act(async () => {
      finish();
      await submission;
    });
    expect(result.current.commentOpen).toBe(false);
  });

  it('resets the comment and error when the reviewed item changes', async () => {
    const controls = reviewControls({
      itemId: 'one',
      rejectWithComment: vi.fn(async () => {}),
      keep: vi.fn(async () => {
        throw new Error('Conflict');
      }),
    });
    const { result, rerender } = renderHook(useGlyphReviewControlsState, { initialProps: controls });
    await act(() => result.current.keep());
    act(() => {
      result.current.openComment();
    });
    act(() => {
      result.current.setComment('Draft');
    });

    rerender({ ...controls, itemId: 'two' });

    expect(result.current.commentOpen).toBe(false);
    expect(result.current.comment).toBe('');
    expect(result.current.error).toBeUndefined();
  });

  it('registers keyboard commands and releases them', () => {
    const registry = commandRegistry();
    const { unmount } = renderHook(useGlyphReviewControlsState, {
      initialProps: reviewControls({ registerCommands: registry.registerCommands }),
    });

    expect(registry.registerCommands).toHaveBeenCalledOnce();

    act(() => {
      unmount();
    });

    expect(registry.dispose).toHaveBeenCalledOnce();
  });

  it('runs each available keyboard command', async () => {
    const registry = commandRegistry();
    const controls = reviewControls({
      registerCommands: registry.registerCommands,
      rejectWithComment: vi.fn(async () => {}),
      previousFile: vi.fn(async () => {}),
      nextFile: vi.fn(async () => {}),
      keepFile: vi.fn(async () => {}),
      undoFile: vi.fn(async () => {}),
      keepAll: vi.fn(async () => {}),
    });
    const { result } = renderHook(useGlyphReviewControlsState, { initialProps: controls });

    for (const command of [
      GlyphReviewCommand.KEEP,
      GlyphReviewCommand.UNDO,
      GlyphReviewCommand.KEEP_FILE,
      GlyphReviewCommand.UNDO_FILE,
      GlyphReviewCommand.KEEP_ALL,
      GlyphReviewCommand.NEXT_FILE,
      GlyphReviewCommand.PREVIOUS_FILE,
      GlyphReviewCommand.NEXT_CHANGE,
      GlyphReviewCommand.PREVIOUS_CHANGE,
      GlyphReviewCommand.ADD_TO_CHAT,
    ])
      await act(async () => {
        registry.handler!(command);
      });

    for (const action of [
      controls.keep,
      controls.undo,
      controls.keepFile,
      controls.undoFile,
      controls.keepAll,
      controls.nextFile,
      controls.previousFile,
      controls.next,
      controls.previous,
    ])
      expect(action).toHaveBeenCalledOnce();

    act(() => {
      registry.handler!(GlyphReviewCommand.COMMENT);
    });
    expect(result.current.commentOpen).toBe(true);
  });

  it('ignores keyboard commands that are disabled or unavailable', async () => {
    const registry = commandRegistry();
    const controls = reviewControls({
      registerCommands: registry.registerCommands,
      disabled: true,
      keepDisabled: true,
      keepAllDisabled: true,
      navigationDisabled: true,
      rejectWithComment: vi.fn(async () => {}),
      previousFile: vi.fn(async () => {}),
      nextFile: vi.fn(async () => {}),
      keepFile: vi.fn(async () => {}),
      undoFile: vi.fn(async () => {}),
      keepAll: vi.fn(async () => {}),
    });
    const { result } = renderHook(useGlyphReviewControlsState, { initialProps: controls });
    const unavailable = commandRegistry();
    const bare = reviewControls({ registerCommands: unavailable.registerCommands });
    renderHook(useGlyphReviewControlsState, { initialProps: bare });

    for (const command of Object.values(GlyphReviewCommand)) {
      await act(async () => {
        registry.handler!(command);
      });
      await act(async () => {
        unavailable.handler!(command);
      });
    }

    for (const action of [
      controls.keep,
      controls.undo,
      controls.keepFile,
      controls.undoFile,
      controls.keepAll,
      controls.nextFile,
      controls.previousFile,
      controls.next,
      controls.previous,
    ])
      expect(action).not.toHaveBeenCalled();
    expect(result.current.commentOpen).toBe(false);
    expect(bare.keep).toHaveBeenCalledOnce();
    expect(bare.undo).toHaveBeenCalledOnce();
  });

  it('ignores keyboard commands while an action is pending or a comment is open', async () => {
    const registry = commandRegistry();
    let finish!: () => void;
    const controls = reviewControls({
      registerCommands: registry.registerCommands,
      rejectWithComment: vi.fn(async () => {}),
      undo: vi.fn(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          }),
      ),
    });
    const { result } = renderHook(useGlyphReviewControlsState, { initialProps: controls });

    act(() => {
      registry.handler!(GlyphReviewCommand.UNDO);
    });
    await act(async () => {
      registry.handler!(GlyphReviewCommand.KEEP);
    });
    expect(controls.keep).not.toHaveBeenCalled();
    act(() => {
      result.current.openComment();
    });
    expect(result.current.commentOpen).toBe(false);

    await act(async () => {
      finish();
    });
    act(() => {
      result.current.openComment();
    });
    await act(async () => {
      registry.handler!(GlyphReviewCommand.KEEP);
    });

    expect(controls.keep).not.toHaveBeenCalled();
  });
});
