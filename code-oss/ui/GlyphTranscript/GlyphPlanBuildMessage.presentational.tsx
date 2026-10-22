import type { ComponentChildren } from 'preact';
import { ListTodo } from 'lucide-preact';
import type { GlyphPlanBuildOrder } from '#src/desktop/protocol/events/GlyphPlanBuildOrder.js';
import { GlyphAnnotationPill } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotations.presentational.tsx';
import { GlyphTodoList } from '#code-oss/ui/GlyphTodoCard/GlyphTodoList.presentational.tsx';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
import type { GlyphTranscriptState } from './useGlyphTranscriptState.ts';
import { GlyphRestoreCheckpoint } from './GlyphTranscript.presentational.tsx';
import { transcriptStyles } from './GlyphTranscript.styles.ts';

const styles = {
  building: css({
    position: 'sticky',
    top: -tokens.space.lg,
    zIndex: 1,
    margin: `0 ${-tokens.space.lg}px ${tokens.space.lg - tokens.space.sm}px`,
    padding: space('sm', 'lg'),
    background: tokens.surface.pane,
  }),
  bubble: css({ padding: 0, overflow: 'hidden', '&:has(.glyph-restore)': { paddingRight: 0 } }),
  quiet: css({ background: tokens.surface.pane, border: tokens.border.default, color: tokens.text.muted }),
  todos: css({ borderBottom: tokens.border.default }),
  lead: css({ padding: '10px 12px', borderBottom: tokens.border.default }),
  header: css({
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    '&:has(.glyph-restore)': { paddingRight: 38 },
    '& .glyph-restore': { top: '50%', transform: 'translateY(-50%)' },
  }),
  open: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    flex: 1,
    minWidth: 0,
    padding: '10px 12px',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
    cursor: 'pointer',
    '&:hover > span:last-child': { textDecoration: 'underline' },
    '&:focus-visible': { outline: tokens.focus.ring, outlineOffset: -2 },
    '&:disabled': { cursor: 'default' },
    '& > span:first-child': { color: tokens.text.muted },
    '& > span:last-child': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '& > svg': { flexShrink: 0, color: tokens.text.muted },
  }),
};

export interface GlyphPlanBuildMessageProps {
  readonly entry: GlyphTranscriptState['entries'][number];
  readonly build: GlyphPlanBuildOrder;
  readonly building: boolean;
  readonly content: ComponentChildren;
  readonly openPlan?: (() => void) | undefined;
}

export function GlyphPlanBuildMessage({ entry, build, building, content, openPlan }: GlyphPlanBuildMessageProps) {
  const lead = entry.parts.some(part => part.type === 'attachment' || part.text.trim());
  return (
    <div
      class={`glyph-entry user glyph-plan-build ${transcriptStyles.entry} ${building ? styles.building : ''}`}
      data-building={building || undefined}
      key={entry.id}
    >
      <div class={`${transcriptStyles.bubble} ${styles.bubble} ${building ? styles.quiet : ''}`}>
        {!building && build.todos.length > 0 && (
          <GlyphTodoList
            class={styles.todos}
            items={build.todos.map(todo => ({
              id: todo.id,
              text: todo.text,
              status: todo.completed ? 'completed' : 'pending',
            }))}
          />
        )}
        {!building && lead && (
          <div
            class={styles.lead}
            data-glyph-source={entry.id}
            data-kind="chat"
            data-label={entry.label}
            data-revision={entry.text.length}
          >
            {content}
          </div>
        )}
        <div class={styles.header}>
          <button
            type="button"
            class={styles.open}
            title={`Open plan: ${build.title}`}
            aria-label={`Build ${build.title}. Open plan`}
            disabled={!openPlan}
            onClick={openPlan}
          >
            <span>Build</span>
            <ListTodo size={16} aria-hidden="true" />
            <span>{build.title}</span>
          </button>
          <GlyphRestoreCheckpoint entry={entry} />
        </div>
      </div>
      {!building && entry.options?.annotations && <GlyphAnnotationPill annotations={entry.options.annotations} />}
      {entry.attachmentError && <p role="alert">{entry.attachmentError}</p>}
    </div>
  );
}
