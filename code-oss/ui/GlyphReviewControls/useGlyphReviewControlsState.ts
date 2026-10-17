import { useEffect, useRef, useState } from 'preact/hooks';
import type { GlyphReviewControls } from '#src/desktop/workbench/GlyphReviewControls.js';
export function useGlyphReviewControlsState(controls: GlyphReviewControls) {
  const busy = useRef(false);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');
  useEffect(() => {
    setCommentOpen(false);
    setComment('');
    setError(undefined);
  }, [controls.itemId]);
  useEffect(() => {
    if (commentOpen) commentInput.current?.focus();
  }, [commentOpen]);
  const perform = async (operation: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const openComment = () => {
    if (controls.disabled || busy.current || !controls.rejectWithComment) return;
    setCommentOpen(true);
  };
  useEffect(
    () =>
      controls.registerShortcuts?.(action => {
        if (busy.current || commentOpen || controls.disabled) return;
        switch (action) {
          case 'keep':
            if (!controls.keepDisabled) void perform(controls.keep);
            break;
          case 'undo':
            void perform(controls.undo);
            break;
          case 'comment':
            openComment();
            break;
        }
      }),
    [controls, commentOpen],
  );
  return {
    ...controls,
    error,
    commentOpen,
    comment,
    commentInput,
    setComment,
    openComment,
    cancelComment: () => {
      if (!busy.current) setCommentOpen(false);
    },
    commentDisabled: controls.disabled || pending || !comment.trim(),
    commentPending: pending,
    submitComment: () =>
      perform(async () => {
        if (controls.disabled || !comment.trim() || !controls.rejectWithComment) return;
        await controls.rejectWithComment(comment);
        setCommentOpen(false);
        setComment('');
      }),
    disabled: controls.disabled || pending || commentOpen,
    keepDisabled: controls.keepDisabled || pending || commentOpen,
    keepAllDisabled: controls.keepAllDisabled || pending || commentOpen,
    previousFile: controls.previousFile ? () => perform(controls.previousFile!) : undefined,
    nextFile: controls.nextFile ? () => perform(controls.nextFile!) : undefined,
    navigationDisabled: controls.navigationDisabled || pending || commentOpen,
    keep: () => perform(controls.keep),
    undo: () => perform(controls.undo),
    keepFile: controls.keepFile ? () => perform(controls.keepFile!) : undefined,
    undoFile: controls.undoFile ? () => perform(controls.undoFile!) : undefined,
    keepAll: controls.keepAll ? () => perform(controls.keepAll!) : undefined,
  };
}
export type GlyphReviewControlsState = ReturnType<typeof useGlyphReviewControlsState>;
