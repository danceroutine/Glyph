import { IconButton } from '#code-oss/ui/Button/Button.tsx';
import { MessageCircle } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const marker = css({
  '&&': { width: 20, height: 20, minHeight: 20, color: tokens.button.background },
  '&&:hover': { color: tokens.button.hoverBackground },
  '&& svg': { width: 15, height: 15 },
});

/** Compact editor gutter affordance; the source selection remains unobstructed. */
export function GlyphEditorAnnotationMarker({
  order,
  comment,
  open,
}: {
  readonly order: number;
  readonly comment: string;
  readonly open: () => void;
}) {
  return (
    <IconButton
      type="button"
      class={`glyph-editor-annotation-marker ${marker}`}
      aria-label={`Edit annotation ${order}`}
      title={comment}
      onMouseDown={event => {
        event.preventDefault();
      }}
      onClick={open}
    >
      <MessageCircle size={15} aria-hidden="true" />
    </IconButton>
  );
}
