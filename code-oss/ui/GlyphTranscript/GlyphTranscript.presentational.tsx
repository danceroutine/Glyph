import { IconButton, ButtonSize } from '#code-oss/ui/Button/Button.tsx';
import { GlyphQuestionResponses } from '#code-oss/ui/GlyphQuestionCard/GlyphQuestionResponses.presentational.tsx';
import { GlyphAnnotationPill } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotations.presentational.tsx';
import { Undo2 } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import type { GlyphTranscriptState } from './useGlyphTranscriptState.ts';
import { GlyphTurnProgress } from '#code-oss/ui/GlyphTurnProgress/GlyphTurnProgress.presentational.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({ flex: 1, minHeight: 0, overflowY: 'auto', padding: tokens.space.lg }),
  entry: css({
    marginBottom: 28,
    userSelect: 'text',
    '&:hover time, &:focus-within time, &:hover .glyph-restore, &:focus-within .glyph-restore': { opacity: 1 },
  }),
  bubble: css({
    position: 'relative',
    background: tokens.input.background,
    border: tokens.input.strongBorder,
    borderRadius: 12,
    padding: '10px 12px',
    '&:has(.glyph-restore)': { paddingRight: 38 },
    '& p:first-child': { marginTop: 0 },
    '& p:last-child': { marginBottom: 0 },
  }),
  steering: css({ background: `color-mix(in srgb, ${tokens.input.background} 70%, black)`, borderStyle: 'dotted' }),
  answer: css({ padding: '0 10px' }),
  restore: css({ position: 'absolute', right: 10, top: 10, opacity: 0 }),
};

export interface GlyphTranscriptProps {
  readonly plans?: ComponentChildren;
  readonly transcript: GlyphTranscriptState['transcript'];
  readonly children: ComponentChildren;
}

/** Stable message keys are supplied by the wired transcript. */
export function GlyphTranscript({ children, transcript, plans }: GlyphTranscriptProps) {
  return (
    <div class={`glyph-transcript ${styles.root}`} ref={transcript} role="log" aria-label="Glyph conversation">
      {children}
      {plans}
    </div>
  );
}

export interface GlyphTranscriptMessageProps {
  readonly entry: GlyphTranscriptState['entries'][number];
  readonly content: ComponentChildren;
}

/** User and diagnostic rows; assistant messages have their own complete component. */
export function GlyphTranscriptMessage({ entry, content }: GlyphTranscriptMessageProps) {
  return (
    <div class={`glyph-entry ${entry.role} ${styles.entry}`} key={entry.id}>
      {entry.questionResponses?.map(response => (
        <GlyphQuestionResponses key={response.id} response={response} />
      ))}
      {entry.role === 'diagnostic' && <strong>{entry.label}</strong>}
      {entry.progress && <GlyphTurnProgress progress={entry.progress} />}
      <div
        data-steering={entry.steering || undefined}
        class={entry.role === 'user' ? `${styles.bubble} ${entry.steering ? styles.steering : ''}` : styles.answer}
      >
        <div data-glyph-source={entry.id} data-kind="chat" data-label={entry.label} data-revision={entry.text.length}>
          {content}
        </div>
        {entry.role === 'user' && entry.restore && (
          <IconButton
            size={ButtonSize.SMALL}
            class={`glyph-restore ${styles.restore}`}
            type="button"
            aria-label="Restore checkpoint"
            title="Restore checkpoint"
            disabled={entry.historyPending}
            onClick={entry.restore}
          >
            <Undo2 size={15} aria-hidden="true" />
          </IconButton>
        )}
      </div>
      {entry.options?.annotations && <GlyphAnnotationPill annotations={entry.options.annotations} />}
      {entry.attachmentError && <p role="alert">{entry.attachmentError}</p>}
    </div>
  );
}
