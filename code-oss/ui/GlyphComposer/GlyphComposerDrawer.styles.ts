import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';

/** Shared layout and motion for the To-dos → Review → Queued Messages drawer stack. */
export const composerDrawerStyles = {
  card: css({
    flexShrink: 0,
    margin: '0 10px -12px',
    paddingBottom: 12,
    border: tokens.border.default,
    borderRadius: '12px 12px 0 0',
    borderBottom: 0,
    background: tokens.surface.pane,
  }),
  reveal: css({
    display: 'grid',
    gridTemplateRows: '0fr',
    transition: 'grid-template-rows 180ms ease-out',
    '&[data-expanded]': { gridTemplateRows: '1fr' },
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  }),
  clip: css({ minHeight: 0, overflow: 'hidden' }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    width: '100%',
    minHeight: 40,
    boxSizing: 'border-box',
    padding: space('md', 'lg'),
  }),
  toggle: css({
    '&&': {
      justifyContent: 'flex-start',
      gap: tokens.space.md,
      border: 0,
      borderRadius: 0,
      textAlign: 'left',
      padding: 0,
      minHeight: 24,
    },
    // Full-width headers carry the same padding as the Review header container.
    '&&[data-drawer-header]': { padding: space('md', 'lg'), minHeight: 40 },
    ':focus-visible': { outlineOffset: tokens.focus.inset },
  }),
  chevron: css({
    display: 'block',
    flexShrink: 0,
    transition: 'transform 180ms ease-out',
    // Up invites opening the drawer; down indicates closing it toward the composer.
    '&[data-expanded]': { transform: 'rotate(180deg)' },
    '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  }),
};
