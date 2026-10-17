import { ChevronRight, FileText } from 'lucide-preact';
import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    marginTop: tokens.space.sm,
    overflow: 'hidden',
    '&[open] .glyph-context-chevron': { transform: 'rotate(90deg)' },
  }),
  summary: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.xs,
    padding: space('sm', 'md'),
    cursor: 'pointer',
    overflowWrap: 'anywhere',
    '&::-webkit-details-marker': { display: 'none' },
    '& svg': { flexShrink: 0 },
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  content: css({
    padding: tokens.space.md,
    borderTop: tokens.border.default,
    color: tokens.text.muted,
    '& pre': {
      color: tokens.text.primary,
      fontFamily: tokens.font.family.code,
      marginBottom: 0,
      maxHeight: 240,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    },
  }),
};

/** Historical captures are immutable data, independent of today's editor model. */
export function GlyphCapturedContext({ attachment }: { readonly attachment: GlyphAttachmentPreview }) {
  return (
    <details class={styles.root} aria-label={`Captured attachment ${attachment.path}`}>
      <summary class={styles.summary}>
        <ChevronRight class="glyph-context-chevron" size={14} aria-hidden="true" />
        <FileText size={14} aria-hidden="true" />
        {attachment.path}
        {attachment.range && ` (${attachment.range.start.line}-${attachment.range.end.line})`}
        {attachment.side && ` · ${attachment.side}`}
      </summary>
      <div class={styles.content}>
        <small>Captured revision {attachment.revision.slice(0, 12)}</small>
        <pre>{attachment.text}</pre>
      </div>
    </details>
  );
}
