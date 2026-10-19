import { IconButton, ButtonSize } from '#code-oss/ui/Button/Button.tsx';
import { Copy, GitFork } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { GlyphQuestionResponses } from '#code-oss/ui/GlyphQuestionCard/GlyphQuestionResponses.presentational.tsx';
import { GlyphAnnotationPill } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotations.presentational.tsx';
import { GlyphTurnProgress } from '#code-oss/ui/GlyphTurnProgress/GlyphTurnProgress.presentational.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphMessageState } from './useGlyphMessageState.ts';

const styles = {
  entry: css({ marginBottom: 28, userSelect: 'text', '&:hover time, &:focus-within time': { opacity: 1 } }),
  answer: css({ padding: '0 10px' }),
  footer: css({
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
    color: tokens.text.muted,
    minHeight: 24,
    '& time': { opacity: 0, fontSize: tokens.font.size.detail },
  }),
};

export interface GlyphAgentMessageProps {
  readonly entry: GlyphMessageState['entries'][number];
  readonly content: ComponentChildren;
  readonly usage: ComponentChildren;
  readonly approval?: ComponentChildren;
  readonly shells?: ComponentChildren;
  readonly modeSwapCards?: ComponentChildren;
}

/** Everything belonging to one assistant message, including its tools and actions. */
export function GlyphAgentMessage({ entry, content, usage, approval, shells, modeSwapCards }: GlyphAgentMessageProps) {
  return (
    <div class={`glyph-entry assistant ${styles.entry}`}>
      {entry.questionResponses?.map(response => (
        <GlyphQuestionResponses key={response.id} response={response} />
      ))}
      {entry.progress && <GlyphTurnProgress progress={entry.progress} openLink={entry.openLink} />}
      {modeSwapCards}
      <div class={styles.answer}>
        <div data-glyph-source={entry.id} data-kind="chat" data-label={entry.label} data-revision={entry.text.length}>
          {content}
        </div>
      </div>
      {entry.options?.annotations && <GlyphAnnotationPill annotations={entry.options.annotations} />}
      {entry.attachmentError && <p role="alert">{entry.attachmentError}</p>}
      {approval}
      {shells}
      <footer class={styles.footer} aria-label="Message actions">
        <IconButton
          size={ButtonSize.SMALL}
          type="button"
          aria-label="Copy message"
          title="Copy message"
          onClick={entry.copy}
        >
          <Copy size={16} aria-hidden="true" />
        </IconButton>
        {entry.branch && (
          <IconButton
            size={ButtonSize.SMALL}

            type="button"
            aria-label="Branch chat"
            title="Branch chat"
            disabled={entry.historyPending}
            onClick={entry.branch}
          >
            <GitFork size={16} aria-hidden="true" />
          </IconButton>
        )}
        {usage}
        {entry.datetime && (
          <time dateTime={entry.createdAt} title={entry.datetime}>
            {entry.datetime}
          </time>
        )}
      </footer>
    </div>
  );
}
