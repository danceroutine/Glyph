import { IconButton, ButtonSize, Button, ButtonVariant, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { GlyphReviewCommand } from '#src/desktop/workbench/GlyphReviewCommand.js';
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphReviewControlsState } from './useGlyphReviewControlsState.ts';
const styles = {
  root: css({
    boxSizing: 'border-box',
    background: tokens.surface.canvas,
    color: tokens.text.primary,

    padding: tokens.space.xs,
    fontFamily: tokens.font.family.body,
    fontSize: tokens.font.size.body,
    maxWidth: '100%',
  }),
  bar: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: tokens.space.xs,
    flexWrap: 'wrap',
    '& > *': { flexShrink: 0, whiteSpace: 'nowrap' },
  }),

  separator: css({ height: 16, borderLeft: tokens.border.default, marginInline: tokens.space.sm }),

  commentForm: css({ display: 'flex', flexDirection: 'column', gap: tokens.space.sm, padding: tokens.space.sm }),
  commentInput: css({
    background: tokens.input.background,
    color: tokens.input.foreground,
    border: tokens.input.border,
    borderRadius: tokens.button.radius,
    font: 'inherit',
    padding: tokens.space.sm,
    resize: 'vertical',
    minHeight: 60,
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  error: css({ color: tokens.text.error, whiteSpace: 'normal', maxWidth: 500, padding: tokens.space.sm }),
};
export function GlyphReviewControls(state: GlyphReviewControlsState) {
  const bar = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const node = bar.current;
    if (!node || !state.fileLabel) return;
    const measure = () => {
      // Measure the full labels on one row, independent of the current compact state.
      const copy = node.cloneNode(true) as HTMLElement;
      Object.assign(copy.style, { position: 'fixed', visibility: 'hidden', width: 'max-content', flexWrap: 'nowrap' });
      copy.querySelector<HTMLElement>('[data-keep-all-suffix]')?.removeAttribute('hidden');
      node.parentElement!.append(copy);
      const required = copy.getBoundingClientRect().width;
      copy.remove();
      setCompact(required > node.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [state.fileLabel, state.fileComplete, state.shortcuts]);
  if (!state.fileLabel && state.fileComplete) return null;
  return (
    <section class={styles.root} aria-label={state.fileLabel ? 'File review controls' : 'Edit review controls'}>
      <div ref={bar} class={styles.bar}>
        {!state.fileComplete && (
          <>
            <IconButton
              size={ButtonSize.SMALL}

              type="button"
              aria-label="Previous change"
              disabled={state.disabled}
              onClick={state.previous}
            >
              <ChevronUp size={16} aria-hidden="true" />
            </IconButton>
            <span>{state.label}</span>
            <IconButton
              size={ButtonSize.SMALL}

              type="button"
              aria-label="Next change"
              disabled={state.disabled}
              onClick={state.next}
            >
              <ChevronDown size={16} aria-hidden="true" />
            </IconButton>
            {state.fileLabel && <span class={styles.separator} aria-hidden="true" />}
            {state.previousFile && (
              <IconButton
                size={ButtonSize.SMALL}

                type="button"
                aria-label="Previous file"
                disabled={state.navigationDisabled}
                onClick={state.previousFile}
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </IconButton>
            )}
            {state.fileLabel && <span>{state.fileLabel}</span>}
            {state.nextFile && (
              <IconButton
                size={ButtonSize.SMALL}

                type="button"
                aria-label="Review Next File"
                disabled={state.navigationDisabled}
                onClick={state.nextFile}
              >
                <ChevronRight size={16} aria-hidden="true" />
              </IconButton>
            )}
            {!state.fileLabel && (
              <Button
                shortcut={state.shortcuts?.[GlyphReviewCommand.UNDO]}
                size={ButtonSize.SMALL}

                type="button"
                aria-label="Undo"
                disabled={state.disabled}
                onClick={state.undo}
              >
                Undo
              </Button>
            )}
            {!state.fileLabel && (
              <Button
                shortcut={state.shortcuts?.[GlyphReviewCommand.KEEP]}
                size={ButtonSize.SMALL}
                variant={ButtonVariant.CONFIRM}

                type="button"
                aria-label="Keep"
                disabled={state.keepDisabled}
                onClick={state.keep}
              >
                Keep
              </Button>
            )}
            {!state.fileLabel && state.rejectWithComment && (
              <Button
                shortcut={state.shortcuts?.[GlyphReviewCommand.COMMENT]}
                size={ButtonSize.SMALL}
                variant={ButtonVariant.PRIMARY}

                type="button"
                aria-label="Reject with comments"
                title="Reject with comments"
                disabled={state.disabled}
                onClick={state.openComment}
              >
                <MessageSquare size={16} aria-hidden="true" />
              </Button>
            )}
            {state.undoFile && (
              <Button
                shortcut={state.shortcuts?.[GlyphReviewCommand.UNDO_FILE]}
                size={ButtonSize.SMALL}
                appearance={ButtonAppearance.OUTLINE}

                type="button"
                aria-label="Undo File"
                disabled={state.disabled}
                onClick={state.undoFile}
              >
                Undo File
              </Button>
            )}
            {state.keepFile && (
              <Button
                shortcut={state.shortcuts?.[GlyphReviewCommand.KEEP_FILE]}
                size={ButtonSize.SMALL}
                variant={ButtonVariant.CONFIRM}

                type="button"
                disabled={state.keepDisabled}
                aria-label="Keep File"
                onClick={state.keepFile}
              >
                Keep File
              </Button>
            )}
          </>
        )}
        {state.fileComplete && state.nextFile && (
          <Button
            shortcut={state.shortcuts?.[GlyphReviewCommand.NEXT_FILE]}
            size={ButtonSize.SMALL}

            type="button"
            aria-label="Review Next File"
            disabled={state.navigationDisabled}
            onClick={state.nextFile}
          >
            Review Next File
          </Button>
        )}
        {state.keepAll && (
          <Button
            shortcut={state.shortcuts?.[GlyphReviewCommand.KEEP_ALL]}
            size={ButtonSize.SMALL}
            variant={ButtonVariant.CONFIRM}
            appearance={ButtonAppearance.OUTLINE}

            type="button"
            aria-label="Keep all changes"
            disabled={state.keepAllDisabled}
            onClick={state.keepAll}
          >
            <span>
              Keep all
              <span data-keep-all-suffix hidden={compact}>
                {' '}
                changes
              </span>
            </span>{' '}
          </Button>
        )}
      </div>
      {state.commentOpen && (
        <form
          class={styles.commentForm}
          aria-label="Rejection comment"
          onSubmit={event => {
            event.preventDefault();
            void state.submitComment();
          }}
        >
          <label htmlFor="glyph-review-comment">Why should this change be revised?</label>
          <textarea
            id="glyph-review-comment"
            ref={state.commentInput}
            class={styles.commentInput}
            value={state.comment}
            maxLength={4000}
            disabled={state.commentPending}
            onInput={event => state.setComment(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                void state.submitComment();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                state.cancelComment();
              }
            }}
          />
          <div class={styles.bar}>
            <Button size={ButtonSize.SMALL} type="button" disabled={state.commentPending} onClick={state.cancelComment}>
              Cancel
            </Button>
            <Button
              size={ButtonSize.SMALL}
              variant={ButtonVariant.PRIMARY}
              type="submit"
              disabled={state.commentDisabled}
            >
              Reject with comment
            </Button>
          </div>
        </form>
      )}
      {state.error && (
        <div class={styles.error} role="alert">
          {state.error}
        </div>
      )}
    </section>
  );
}
