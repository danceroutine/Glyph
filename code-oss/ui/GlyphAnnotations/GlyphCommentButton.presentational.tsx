import { Button, ButtonAppearance, ButtonSize } from '#code-oss/ui/Button/Button.tsx';
import { MessageCircle } from 'lucide-preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
const styles = {
  button: css({
    '&&': {
      position: 'relative',
      display: 'inline-grid',
      placeItems: 'center',
      width: 30,
      height: 30,
      minHeight: 0,
      padding: 0,
      border: 0,
      fontSize: tokens.font.size.body,
      lineHeight: 1,
      color: tokens.button.foreground,
    },
    '& > svg': { position: 'absolute', inset: 0, width: '100%', height: '100%', fill: tokens.button.background },
    '&:hover > svg': { fill: tokens.button.hoverBackground },
    '& > span': { position: 'relative', paddingBottom: tokens.space.xxs },
  }),

  positioned: css({ '&&': { position: 'fixed', zIndex: 1000 } }),
};
export function GlyphCommentButton({
  open,
  order,
  position,
  shortcut,
}: {
  readonly open: () => void;
  readonly order?: number;
  readonly shortcut?: string;
  readonly position?: { readonly x: number; readonly y: number };
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [width, setWidth] = useState(0);
  const selection = position !== undefined && (order ?? 0) === 0;
  useLayoutEffect(() => {
    if (!selection || !button.current) return undefined;
    const measure = () => {
      setWidth(button.current!.getBoundingClientRect().width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(button.current);
    return () => {
      observer.disconnect();
    };
  }, [selection]);
  const left =
    position && selection ? Math.max(8, Math.min(innerWidth - width - 8, position.x - width / 2)) : position?.x;
  if ((order ?? 0) === 0)
    return (
      <Button
        buttonRef={button}
        appearance={ButtonAppearance.OUTLINE}
        size={ButtonSize.LARGE}
        class={`glyph-annotation-marker ${position ? styles.positioned : ''}`}
        style={position ? { left: `${left}px`, top: `${position.y}px` } : {}}
        aria-label="Comment on selection"
        onMouseDown={event => {
          event.preventDefault();
        }}
        onClick={open}
        shortcut={shortcut}
      >
        Add to Chat
      </Button>
    );
  return (
    <Button
      appearance={ButtonAppearance.GHOST}
      buttonRef={button}
      type="button"
      class={`glyph-annotation-marker ${styles.button} ${position ? styles.positioned : ''}`}
      style={position ? { left: `${left}px`, top: `${position.y}px` } : {}}
      aria-label={`Edit annotation ${order}`}
      onMouseDown={event => {
        event.preventDefault();
      }}
      onClick={open}
    >
      <MessageCircle aria-hidden="true" strokeWidth={1.8} />
      <span>{order}</span>
    </Button>
  );
}
