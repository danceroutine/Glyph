import { Button, ButtonAppearance, IconButton } from '#code-oss/ui/Button/Button.tsx';
import { GlyphSidebarIcon } from '#code-oss/ui/GlyphSidebarIcon/GlyphSidebarIcon.tsx';
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
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    height: 36,
    flexShrink: 0,
    gap: tokens.space.xxs,
    paddingRight: tokens.space.xs,
    borderBottom: tokens.border.default,
  }),
  tabs: css({ display: 'flex', flex: 1, minWidth: 0, height: '100%', overflowX: 'auto', scrollbarWidth: 'none' }),
  tab: css({
    display: 'flex',
    alignItems: 'center',
    flex: '0 1 200px',
    minWidth: 140,
    maxWidth: 220,
    borderRight: tokens.border.default,
    borderTop: '1px solid transparent',
    color: tokens.text.muted,
    '&[data-selected]': {
      color: tokens.text.primary,
      borderTopColor: tokens.focus.color,
      background: tokens.surface.canvas,
    },
  }),
  selectTab: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    flex: 1,
    minWidth: 0,
    height: '100%',
    padding: space('sm', 'lg'),
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    cursor: 'pointer',
    '&:hover': { color: tokens.text.primary },
    '&:focus-visible': { outline: tokens.focus.ring, outlineOffset: -1 },
    '& > span': { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '& > svg': { flexShrink: 0 },
  }),
  close: css({ flexShrink: 0, marginRight: tokens.space.xs }),

  body: css({ position: 'relative', display: 'flex', flex: 1, minHeight: 0, minWidth: 0, overflowX: 'auto' }),
  conversation: css({ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }),
  error: css({ padding: space('md', 'lg'), color: tokens.text.error, overflowWrap: 'anywhere' }),
  workspaceStatus: css({ padding: space('md', 'lg'), color: tokens.text.muted, overflowWrap: 'anywhere' }),
};

export type GlyphWorkbenchProps = Pick<
  GlyphWorkbenchState,
  | 'root'
  | 'toggle'
  | 'historyOpen'
  | 'tabs'
  | 'selectTab'
  | 'closeTab'
  | 'newChatDisabled'
  | 'navigationError'
  | 'newChat'
  | 'toggleHistory'
  | 'closeHistory'
> & {
  readonly recentChats: ComponentChildren;
  readonly workspaceMessage?: string;
  readonly retryWorkspace?: () => void;
  readonly menu: ComponentChildren;
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
  tabs,
  selectTab,
  closeTab,
  newChatDisabled,
  navigationError,
  newChat,
  toggleHistory,
  closeHistory,
  recentChats,
  workspaceMessage,
  retryWorkspace,
  menu,
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
      <div class={styles.body}>
        <main class={styles.conversation} aria-label="Current conversation">
          <header class={`glyph-chat-header ${styles.header}`}>
            <div class={styles.tabs} role="tablist" aria-label="Open chats">
              {tabs.map((tab, index) => (
                <div key={tab.id} class={styles.tab} role="presentation" data-selected={tab.selected || undefined}>
                  <button
                    type="button"
                    role="tab"
                    class={styles.selectTab}
                    aria-selected={tab.selected}
                    tabIndex={tab.selected ? 0 : -1}
                    title={tab.title}
                    disabled={newChatDisabled}
                    onClick={() => {
                      selectTab(tab.id);
                    }}
                    ref={element => {
                      if (tab.selected) element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    }}
                    onKeyDown={event => {
                      const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                      if (offset || event.key === 'Home' || event.key === 'End') {
                        event.preventDefault();
                        const next =
                          event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? tabs.length - 1
                              : (index + offset + tabs.length) % tabs.length;
                        const list = event.currentTarget.closest('[role="tablist"]');
                        selectTab(tabs[next]!.id);
                        list?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                      } else if (event.key === 'Delete') {
                        event.preventDefault();
                        closeTab(tab.id);
                      }
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
                      <path d="M3 3h12v9H7l-4 3V3Z" stroke="currentColor" fill="none" stroke-width="1.3" />
                    </svg>
                    <span>{tab.title}</span>
                  </button>
                  {(tab.id || tabs.length > 1) && (
                    <IconButton
                      class={styles.close}
                      type="button"
                      aria-label={`Close ${tab.title}`}
                      title="Close chat tab"
                      disabled={newChatDisabled}
                      onClick={() => {
                        closeTab(tab.id);
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden="true">
                        <path d="m5 5 8 8M13 5l-8 8" stroke="currentColor" stroke-width="1.4" />
                      </svg>
                    </IconButton>
                  )}
                </div>
              ))}
            </div>
            <IconButton
              type="button"
              aria-label="New chat"
              title="New chat"
              disabled={newChatDisabled}
              onClick={newChat}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                <path d="M9 3v12M3 9h12" stroke="currentColor" stroke-width="1.5" />
              </svg>
            </IconButton>
            {!historyOpen && recentChats}
            {menu}
            {!historyOpen && (
              <IconButton
                buttonRef={toggle}
                appearance={ButtonAppearance.BORDERLESS_GHOST}
                iconSize={18}
                type="button"
                aria-label="Chat history"
                title="Open sidebar"
                aria-expanded={historyOpen}
                aria-controls="glyph-chat-history"
                onClick={toggleHistory}
              >
                <GlyphSidebarIcon />
              </IconButton>
            )}
          </header>
          {workspaceMessage !== undefined && workspaceMessage !== '' && (
            <div role="status" class={styles.workspaceStatus}>
              {workspaceMessage}
              {retryWorkspace && (
                <Button appearance={ButtonAppearance.BORDERLESS_GHOST} onClick={retryWorkspace}>
                  Retry
                </Button>
              )}
            </div>
          )}
          {transcript}
          {navigationError !== undefined && navigationError !== '' && (
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
