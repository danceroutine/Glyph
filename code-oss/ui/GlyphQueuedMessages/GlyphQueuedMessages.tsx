import { Button, ButtonSize, ButtonAppearance, IconButton } from '#code-oss/ui/Button/Button.tsx';
import { composerDrawerStyles as drawer } from '#code-oss/ui/GlyphComposer/GlyphComposerDrawer.styles.ts';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { ChevronUp, MessageSquare, CornerDownLeft, MoreHorizontal, Pencil, Trash2 } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphComposerState } from '#code-oss/ui/GlyphComposer/useGlyphComposerState.ts';

const styles = {
  tray: css({ position: 'relative' }),
  rows: css({ maxHeight: 180, overflowY: 'auto', padding: '0 12px 8px' }),
  row: css({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderRadius: 6,
    margin: '0 -6px',
    padding: '4px 6px',
    minHeight: 26,
    cursor: 'grab',
    ':active': { cursor: 'grabbing' },
    ':hover, :focus-within, &[data-menu-open]': { background: tokens.button.secondary.hoverBackground },
    '&[data-editing]': {
      boxShadow: `inset 0 0 0 1px ${tokens.focus.color}`,
      background: `color-mix(in srgb, ${tokens.focus.color} 12%, ${tokens.surface.pane})`,
      cursor: 'default',
    },
    '& .glyph-queue-actions': { display: 'none' },
    '&:hover .glyph-queue-actions, &:focus-within .glyph-queue-actions, &[data-menu-open] .glyph-queue-actions, &[data-editing] .glyph-queue-actions':
      {
        display: 'flex',
      },
    ':focus-visible': { outline: tokens.focus.ring },
  }),
  notice: css({ margin: '8px 12px' }),
  resume: css({ margin: '0 8px 8px' }),
  text: css({ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  actions: css({ display: 'flex', alignItems: 'center', gap: 2 }),
  action: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    color: tokens.text.muted,
    background: 'transparent',
    border: 0,
    font: 'inherit',
    padding: 4,
    borderRadius: 4,
    cursor: 'pointer',
    ':hover': { color: tokens.text.primary },
    ':focus-visible': { outline: tokens.focus.ring },
    ':disabled': { opacity: 0.4, cursor: 'default' },
  }),
  menu: css({
    position: 'fixed',
    zIndex: 5,
    minWidth: 190,
    padding: 6,
    border: tokens.input.strongBorder,
    borderRadius: 10,
    background: tokens.surface.canvas,
    boxShadow: '0 4px 16px #0006',
    '& button': { display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px' },
    '& hr': { border: 0, borderTop: tokens.input.strongBorder },
  }),
};

/** The message icon is decorative; rows reorder by dragging or Alt+ArrowUp/Down. */
export function GlyphQueuedMessages({ state }: { readonly state: GlyphComposerState }) {
  const [collapsed, setCollapsed] = useState(false);
  const listId = useId();
  const [menu, setMenu] = useState<string>();
  const dragged = useRef<string | undefined>(undefined);
  const root = useRef<HTMLElement>(null);
  const anchor = useRef<DOMRect | undefined>(undefined);
  const positionMenu = (element: HTMLDivElement | null) => {
    if (!element || !anchor.current) return;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(anchor.current.right - bounds.width, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(anchor.current.bottom + 4, window.innerHeight - bounds.height - 8))}px`;
  };
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu(undefined);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  if (!state.queued.length) return null;
  const blocked = state.disabled || !!state.queueSubmitting || !!state.editingQueuedMessage;
  return (
    <section
      class={`glyph-queued-messages ${drawer.card} ${styles.tray}`}
      ref={root}
      aria-label="Queued messages"
      onKeyDown={event => {
        if (event.key === 'Escape') setMenu(undefined);
      }}
    >
      <Button
        appearance={ButtonAppearance.GHOST}
        class={`${drawer.header} ${drawer.toggle}`}
        data-drawer-header
        type="button"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => {
          setCollapsed(!collapsed);
          setMenu(undefined);
        }}
      >
        <ChevronUp class={drawer.chevron} data-expanded={!collapsed || undefined} size={16} aria-hidden="true" />
        {state.queued.length} Queued {state.queued.length === 1 ? 'Message' : 'Messages'}
      </Button>
      <div class={drawer.reveal} data-expanded={!collapsed || undefined} aria-hidden={collapsed} inert={collapsed}>
        <div class={drawer.clip}>
          <div id={listId} class={styles.rows} role="list">
            {state.queued.map((message, index) => (
              <div
                key={message.id}
                class={styles.row}
                data-menu-open={menu === message.id || undefined}
                data-editing={state.editingQueuedMessage === message.id || undefined}
                role="listitem"
                tabIndex={0}
                draggable={!blocked}
                aria-label={`Queued message ${index + 1}: ${message.text}`}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                onDragStart={event => {
                  if ((event.target as HTMLElement).closest('button')) {
                    event.preventDefault();
                    return;
                  }
                  dragged.current = message.id;
                  event.dataTransfer!.effectAllowed = 'move';
                  event.dataTransfer!.setData('text/plain', message.id);
                }}
                onDragEnd={() => {
                  dragged.current = undefined;
                }}
                onDragOver={event => {
                  if (dragged.current && !blocked) event.preventDefault();
                }}
                onDrop={event => {
                  event.preventDefault();
                  if (dragged.current && !blocked) state.moveQueued(dragged.current, index);
                  dragged.current = undefined;
                }}
                onKeyDown={event => {
                  if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && !blocked) {
                    event.preventDefault();
                    event.stopPropagation();
                    state.moveQueued(message.id, index + (event.key === 'ArrowUp' ? -1 : 1));
                  }
                }}
              >
                <MessageSquare size={16} color={tokens.text.muted} style={{ flexShrink: 0 }} aria-hidden="true" />
                <span class={styles.text}>{message.text}</span>
                <div class={`glyph-queue-actions ${styles.actions}`}>
                  {state.editingQueuedMessage !== message.id && (
                    <>
                      <Button
                        appearance={ButtonAppearance.GHOST}
                        size={ButtonSize.SMALL}

                        type="button"
                        disabled={blocked}
                        onClick={() => state.sendQueued(message.id)}
                        aria-label="Send queued message immediately"
                      >
                        Send Now <CornerDownLeft size={14} aria-hidden="true" />
                      </Button>
                      <IconButton
                        appearance={ButtonAppearance.GHOST}
                        size={ButtonSize.SMALL}

                        type="button"
                        disabled={blocked}
                        onClick={() => state.editQueued(message.id)}
                        aria-label="Edit queued message"
                      >
                        <Pencil size={16} aria-hidden="true" />
                      </IconButton>
                    </>
                  )}
                  <IconButton
                    appearance={ButtonAppearance.GHOST}
                    size={ButtonSize.SMALL}

                    type="button"
                    disabled={
                      state.disabled ||
                      !!state.queueSubmitting ||
                      (!!state.editingQueuedMessage && state.editingQueuedMessage !== message.id)
                    }
                    onClick={() => state.removeQueued(message.id)}
                    aria-label="Remove queued message"
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </IconButton>
                  {state.editingQueuedMessage !== message.id && (
                    <IconButton
                      appearance={ButtonAppearance.GHOST}
                      size={ButtonSize.SMALL}

                      type="button"
                      disabled={blocked}
                      onClick={event => {
                        anchor.current = event.currentTarget.getBoundingClientRect();
                        setMenu(menu === message.id ? undefined : message.id);
                      }}
                      aria-label="Queued message actions"
                      aria-haspopup="menu"
                      aria-expanded={menu === message.id}
                    >
                      <MoreHorizontal size={18} aria-hidden="true" />
                    </IconButton>
                  )}
                </div>
              </div>
            ))}
          </div>
          {state.queueError && (
            <p class={styles.notice} role="alert">
              {state.queueError}
            </p>
          )}
          {state.queuePaused && (
            <Button
              appearance={ButtonAppearance.GHOST}
              size={ButtonSize.SMALL}
              class={styles.resume}
              type="button"
              disabled={state.disabled}
              onClick={state.resumeQueue}
            >
              Resume queue
            </Button>
          )}
        </div>
      </div>
      {menu && (
        <div class={styles.menu} ref={positionMenu} role="menu">
          <Button
            appearance={ButtonAppearance.GHOST}
            size={ButtonSize.SMALL}

            role="menuitem"
            type="button"
            disabled={blocked}
            onClick={() => {
              state.moveQueuedToNewChat(menu);
              setMenu(undefined);
            }}
          >
            Move to New Chat
          </Button>
          <Button
            appearance={ButtonAppearance.GHOST}
            size={ButtonSize.SMALL}

            role="menuitem"
            type="button"
            disabled={blocked || !state.active}
            onClick={() => {
              state.steerQueued(menu);
              setMenu(undefined);
            }}
          >
            Steer
          </Button>
          <hr />
          <Button
            appearance={ButtonAppearance.GHOST}
            size={ButtonSize.SMALL}

            role="menuitem"
            type="button"
            onClick={() => {
              state.openMessageSettings();
              setMenu(undefined);
            }}
          >
            New Message Settings
          </Button>
        </div>
      )}
    </section>
  );
}
