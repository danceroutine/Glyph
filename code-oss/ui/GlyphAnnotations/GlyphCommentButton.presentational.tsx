import { MessageCircle } from 'lucide-preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
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
  selection: css({
    width: 'auto',
    height: 24,
    padding: '2px 8px',
    borderRadius: 6,
    color: tokens.text.primary,
    background: tokens.button.secondary.background,
    border: tokens.border.default,
    whiteSpace: 'nowrap',
    fontSize: tokens.font.size.body,
    ':hover': { background: tokens.button.secondary.hoverBackground },
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
  const button = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(0);
  const selection = !!position && !order;
  useLayoutEffect(() => {
    if (!selection || !button.current) return;
    const measure = () => setWidth(button.current!.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(button.current);
    return () => observer.disconnect();
  }, [selection]);
  const left =
    position && selection ? Math.max(8, Math.min(innerWidth - width - 8, position.x - width / 2)) : position?.x;
  return (
    <button
      ref={button}
      type="button"
      class={`glyph-annotation-marker ${styles.button} ${order ? '' : styles.selection} ${position ? styles.positioned : ''}`}
      style={position ? { left: `${left}px`, top: `${position.y}px` } : undefined}
      aria-label={order ? `Edit annotation ${order}` : 'Comment on selection'}
      onMouseDown={event => event.preventDefault()}
      onClick={open}
    >
      {order ? <MessageCircle aria-hidden="true" strokeWidth={1.8} /> : 'Add to chat'}
      {order && <span>{order}</span>}
    </button>
  );
}
