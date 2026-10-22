import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';

export const transcriptStyles = {
  root: css({ flex: 1, minHeight: 0, overflowY: 'auto', padding: tokens.space.lg }),
  entry: css({
    marginBottom: tokens.space.lg,
    userSelect: 'text',
    '&:hover time, &:focus-within time, &:hover .glyph-restore, &:focus-within .glyph-restore': { opacity: 1 },
  }),
  bubble: css({
    position: 'relative',
    background: tokens.input.background,
    border: tokens.input.strongBorder,
    borderRadius: 12,
    padding: '10px 12px',
    '&:has(.glyph-restore)': { paddingRight: 38 },
    '& p:first-child': { marginTop: 0 },
    '& p:last-child': { marginBottom: 0 },
  }),
  steering: css({ background: `color-mix(in srgb, ${tokens.input.background} 70%, black)`, borderStyle: 'dotted' }),
  answer: css({ padding: '0 10px' }),
  restore: css({ position: 'absolute', right: 10, top: 10, opacity: 0 }),
  rider: css({ border: tokens.border.default, borderRadius: 12, background: tokens.surface.pane }),
  riderBubble: css({ margin: -1 }),
  riderRow: css({
    display: 'flex',
    alignItems: 'center',
    gap: tokens.space.md,
    padding: space('sm', 'lg'),
    color: tokens.text.primary,
    fontSize: tokens.font.size.body,
    '& > span': { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '& > small': { color: tokens.text.muted, fontSize: 'inherit', fontVariantNumeric: 'tabular-nums' },
  }),
};
