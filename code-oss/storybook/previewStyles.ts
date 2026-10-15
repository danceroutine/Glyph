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
  '&[data-theme="light"]': previewThemeStyles('light'),
});

export const frameClassName = css({
  boxSizing: 'border-box',
  maxWidth: '100%',
  height: `calc(100vh - ${space('xxxl')})`,
  minHeight: 320,
  background: tokens.surface.pane,
  border: tokens.border.default,
  '& textarea, & button, & select': { font: 'inherit' },
  '& :focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.inset },
});
