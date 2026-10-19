import { css, tokens, space, previewThemeStyles } from '#code-oss/ui/design-system/index.ts';

export const stageClassName = css({
  ...previewThemeStyles('dark'),
  boxSizing: 'border-box',
  minHeight: '100vh',
  padding: tokens.space.xl,
  background: tokens.surface.canvas,
  color: tokens.text.primary,
  fontFamily: tokens.font.family.body,
  fontSize: tokens.font.size.inherited,
  // The native workbench supplies this inherited line height.
  lineHeight: 1.4,
  '&[data-theme="light"]': previewThemeStyles('light'),
});

export const frameClassName = css({
  boxSizing: 'border-box',
  width: 'var(--glyph-preview-width)',
  maxWidth: '100%',
  '&:has(.glyph-workbench[data-history-open])': {
    width: `calc(var(--glyph-preview-width) + ${tokens.history.columnWidth}px)`,
  },
  height: `calc(100vh - ${space('xxxl')})`,
  minHeight: 320,
  background: tokens.surface.pane,
  border: tokens.border.default,
  '& textarea, & button, & select': { font: 'inherit' },
  '& :focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.inset },
});
