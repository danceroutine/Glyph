import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { GlyphProposalFileSummary } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
const styles = {
  card: css({
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    overflow: 'hidden',
    marginBlock: tokens.space.md,
  }),
  button: css({
    display: 'flex',
    gap: tokens.space.sm,
    width: '100%',
    textAlign: 'left',
    padding: space('md', 'lg'),
    border: 0,
    color: tokens.text.primary,
    background: tokens.surface.pane,
    font: 'inherit',
    cursor: 'pointer',
    ':hover': { background: tokens.list.hoverBackground },
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.inset },
  }),
  name: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  code: css({
    margin: 0,
    padding: tokens.space.md,
    background: tokens.surface.canvas,
    overflowX: 'auto',
    fontFamily: tokens.font.family.code,
    fontSize: tokens.font.size.detail,
  }),
  added: css({ color: tokens.diff.added }),
  removed: css({ color: tokens.diff.removed }),
};
export function GlyphProposalPreview({
  file,
  name,
  open,
  disabled,
}: {
  readonly file: GlyphProposalFileSummary;
  readonly name: string;
  readonly open: () => void;
  readonly disabled: boolean;
}) {
  return (
    <section class={styles.card} aria-label={`Proposed changes to ${file.path}`}>
      <button type="button" class={styles.button} title={file.path} onClick={open} disabled={disabled}>
        <span class={styles.name}>{name}</span>
        <span class={styles.added}>+{file.additions ?? 0}</span>
        <span class={styles.removed}>−{file.deletions ?? 0}</span>
      </button>
      <pre class={styles.code}>
        {file.preview?.map((line, index) => (
          <div key={index} class={line.added ? styles.added : styles.removed}>
            {line.added ? '+' : '−'} {line.text}
          </div>
        ))}
      </pre>
    </section>
  );
}
