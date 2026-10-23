import { IconButton, ButtonSize } from '#code-oss/ui/Button/Button.tsx';
import { GlyphQuestionResponses } from '#code-oss/ui/GlyphQuestionCard/GlyphQuestionResponses.presentational.tsx';
import { GlyphAnnotationPill } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotations.presentational.tsx';
import { Undo2 } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import type { GlyphTranscriptState } from './useGlyphTranscriptState.ts';
import { GlyphTurnProgress } from '#code-oss/ui/GlyphTurnProgress/GlyphTurnProgress.presentational.tsx';
import { GlyphPlanProgressRider } from './GlyphPlanProgressRider.presentational.tsx';
import { transcriptStyles as styles } from './GlyphTranscript.styles.ts';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';

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

export function GlyphRestoreCheckpoint({ entry }: { readonly entry: GlyphTranscriptState['entries'][number] }) {
  return entry.role === GlyphTranscriptRole.USER && entry.restore ? (
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
  ) : null;
}

/** User and diagnostic rows; assistant messages have their own complete component. */
export function GlyphTranscriptMessage({ entry, content }: GlyphTranscriptMessageProps) {
  const progress = entry.role === GlyphTranscriptRole.USER ? entry.options?.planProgress : undefined;
  const bubble = (
    <div
      data-steering={entry.steering || undefined}
      class={
        entry.role === GlyphTranscriptRole.USER
          ? `${styles.bubble} ${entry.steering ? styles.steering : ''} ${progress ? styles.riderBubble : ''}`
          : styles.answer
      }
    >
      <div data-glyph-source={entry.id} data-kind="chat" data-label={entry.label} data-revision={entry.text.length}>
        {content}
      </div>
      <GlyphRestoreCheckpoint entry={entry} />
    </div>
  );
  return (
    <div class={`glyph-entry ${entry.role} ${styles.entry}`} key={entry.id}>
      {entry.questionResponses?.map(response => (
        <GlyphQuestionResponses key={response.id} response={response} />
      ))}
      {entry.role === GlyphTranscriptRole.DIAGNOSTIC && <strong>{entry.label}</strong>}
      {entry.progress && <GlyphTurnProgress progress={entry.progress} openLink={entry.openLink} />}
      {progress ? (
        <div class={styles.rider}>
          {bubble}
          <GlyphPlanProgressRider progress={progress} />
        </div>
      ) : (
        bubble
      )}
      {entry.options?.annotations && <GlyphAnnotationPill annotations={entry.options.annotations} />}
      {entry.attachmentError !== undefined && entry.attachmentError !== '' && (
        <p role="alert">{entry.attachmentError}</p>
      )}
    </div>
  );
}
