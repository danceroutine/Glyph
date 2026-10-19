import { IconButton } from '#code-oss/ui/Button/Button.tsx';
import type { ComponentChildren } from 'preact';
import type { GlyphWorkbenchState } from './useGlyphWorkbenchState.ts';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';

/** Also used by standalone component stories to reproduce the pane layout. */
export const workbenchClassName = css({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  containerType: 'inline-size',
  '&[data-history-open] main': { minWidth: 240 },
});

const styles = {
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    padding: space('md', 'lg'),
    borderBottom: tokens.border.default,
  }),
  title: css({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: tokens.font.weight.semibold,
  }),

  body: css({ position: 'relative', display: 'flex', flex: 1, minHeight: 0, minWidth: 0, overflowX: 'auto' }),
  conversation: css({ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }),
  error: css({ padding: space('md', 'lg'), color: tokens.text.error, overflowWrap: 'anywhere' }),
};

export type GlyphWorkbenchProps = Pick<
  GlyphWorkbenchState,
  | 'root'
  | 'toggle'
  | 'historyOpen'
  | 'title'
  | 'newChatDisabled'
  | 'navigationError'
  | 'newChat'
  | 'toggleHistory'
  | 'closeHistory'
> & {
  readonly transcript: ComponentChildren;
  readonly usage: ComponentChildren;
  readonly question: ComponentChildren;
  readonly composer: ComponentChildren;
  readonly history: ComponentChildren;
};

export function GlyphWorkbench({
  root,
  toggle,
  historyOpen,
  title,
  newChatDisabled,
  navigationError,
  newChat,
  toggleHistory,
  closeHistory,
  transcript,
  usage,
  question,
  composer,
  history,
}: GlyphWorkbenchProps) {
  return (
    <div
      ref={root}
      data-history-open={historyOpen || undefined}
      class={`glyph-workbench ${workbenchClassName}`}
      onKeyDown={event => {
        if (event.key === 'Escape' && historyOpen) {
          event.stopPropagation();
          closeHistory();
        }
      }}
    >
      <header class={styles.header}>
        <span class={styles.title}>{title}</span>
        <IconButton type="button" aria-label="New chat" title="New chat" disabled={newChatDisabled} onClick={newChat}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </IconButton>
        <IconButton
          buttonRef={toggle}

          type="button"
          aria-label="Chat history"
          title="Chat history"
          aria-expanded={historyOpen}
          aria-controls="glyph-chat-history"
          onClick={toggleHistory}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="2" y="3" width="14" height="12" rx="1" stroke="currentColor" fill="none" />
            <path d="M11 3v12" stroke="currentColor" />
          </svg>
        </IconButton>
      </header>
      <div class={styles.body}>
        <main class={styles.conversation} aria-label="Current conversation">
          {transcript}
          {navigationError && (
            <div class={styles.error} role="alert">
              {navigationError}
            </div>
          )}
          {question}
          {composer}
          {usage}
        </main>
        {history}
      </div>
    </div>
  );
}
