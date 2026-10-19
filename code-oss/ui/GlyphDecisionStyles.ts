import { css, tokens, space } from './design-system/index.ts';

export const decisionStyles = {
  card: css({
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    background: tokens.surface.pane,
    color: tokens.text.primary,
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    minWidth: 0,
    '& button, & input, & textarea': { font: 'inherit' },
    '& button:focus-visible, & input:focus-visible, & textarea:focus-visible': {
      outline: tokens.focus.ring,
      outlineOffset: tokens.focus.offset,
    },
    '& button:disabled': { opacity: tokens.opacity.disabled, cursor: 'default' },
  }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    padding: space('lg', 'lg'),
    '& h3': {
      margin: tokens.space.none,
      fontSize: tokens.font.size.body,
      fontWeight: tokens.font.weight.semibold,
      flex: 1,
    },
  }),
  actions: css({
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: tokens.space.md,
    padding: space('lg', 'lg'),
  }),

  detail: css({ fontSize: tokens.font.size.caption, color: tokens.text.muted }),
  error: css({ padding: space('none', 'lg', 'lg'), color: tokens.text.error }),
};
