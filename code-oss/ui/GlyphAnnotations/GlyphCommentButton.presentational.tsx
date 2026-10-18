import { MessageCircle, MessageSquareText } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
const styles = {
  button: css({
    position: 'relative',
    display: 'inline-grid',
    placeItems: 'center',
    flexShrink: 0,
    width: 30,
    height: 30,
    padding: 0,
    border: 0,
    font: 'inherit',
    fontSize: tokens.font.size.body,
    lineHeight: 1,
    color: tokens.button.foreground,
    background: 'transparent',
    cursor: 'pointer',
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.offset },
    '& > svg': { position: 'absolute', inset: 0, width: '100%', height: '100%', fill: tokens.button.background },
    '&:hover > svg': { fill: tokens.button.hoverBackground },
    '& > span': { position: 'relative', paddingBottom: tokens.space.xxs },
  }),
  positioned: css({ position: 'fixed', zIndex: 1000 }),
};
export function GlyphCommentButton({
  open,
  order,
  position,
}: {
  readonly open: () => void;
  readonly order?: number;
  readonly position?: { readonly x: number; readonly y: number };
}) {
  return (
    <button
      type="button"
      class={`glyph-annotation-marker ${styles.button} ${position ? styles.positioned : ''}`}
      style={position ? { left: `${position.x}px`, top: `${position.y}px` } : undefined}
      aria-label={order ? `Edit annotation ${order}` : 'Comment on selection'}
      onMouseDown={event => event.preventDefault()}
      onClick={open}
    >
      {order ? (
        <MessageCircle aria-hidden="true" strokeWidth={1.8} />
      ) : (
        <MessageSquareText aria-hidden="true" strokeWidth={1.8} />
      )}
      {order && <span>{order}</span>}
    </button>
  );
}
