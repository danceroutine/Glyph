import { Button, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { composerDrawerStyles as drawer } from '#code-oss/ui/GlyphComposer/GlyphComposerDrawer.styles.ts';
import { ChevronUp } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import { GlyphTodoList } from './GlyphTodoList.presentational.tsx';
import type { GlyphTodoCardState } from './useGlyphTodoCardState.ts';

const styles = {
  card: css({ overflow: 'hidden' }),
  list: css({ borderTop: tokens.border.default }),
};

export function GlyphTodoCard({ expanded, listId, summary, items, toggle }: GlyphTodoCardState) {
  return (
    <section class={`glyph-todos ${drawer.card} ${styles.card}`} aria-label="To-dos">
      <Button
        appearance={ButtonAppearance.GHOST}
        type="button"
        class={`${drawer.header} ${drawer.toggle}`}
        data-drawer-header
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={toggle}
      >
        <ChevronUp class={drawer.chevron} data-expanded={expanded || undefined} size={16} aria-hidden="true" />
        <span aria-live="polite">{summary}</span>
      </Button>
      <div class={drawer.reveal} data-expanded={expanded || undefined} aria-hidden={!expanded} inert={!expanded}>
        <div class={drawer.clip}>
          <GlyphTodoList id={listId} items={items} class={styles.list} />
        </div>
      </div>
    </section>
  );
}
