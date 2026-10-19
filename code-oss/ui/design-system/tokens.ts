import { atoms } from './atoms.ts';
import { codeOss } from './codeOssTheme.ts';

const border = (color: string) => `${atoms.borderWidth.thin}px solid ${color}`;
const tint = (color: string) => `color-mix(in srgb, ${color} ${atoms.opacity.tint * 100}%, transparent)`;

/** Universal roles plus component groups that own all of their visual tokens. */
export const tokens = {
  space: atoms.space,
  text: {
    primary: codeOss.foreground,
    muted: codeOss.descriptionForeground,
    error: codeOss.errorForeground,
    warning: codeOss.editorWarning.foreground,
  },
  surface: { pane: codeOss.sideBar.background, canvas: codeOss.editor.background },
  border: { color: codeOss.panel.border, default: border(codeOss.panel.border) },
  focus: {
    color: codeOss.focusBorder,
    ring: border(codeOss.focusBorder),
    offset: atoms.space.xxs,
    inset: -atoms.borderWidth.thin,
  },
  font: {
    family: { body: codeOss.font.family, code: codeOss.editor.font.family },
    size: {
      caption: atoms.fontSize.xs,
      detail: atoms.fontSize.sm,
      body: atoms.fontSize.md,
      heading: atoms.fontSize.lg,
      title: atoms.fontSize.xl,
      inherited: codeOss.font.size,
    },
    weight: atoms.fontWeight,
    lineHeight: atoms.lineHeight,
  },
  opacity: atoms.opacity,
  layout: { widePane: 680 },
  input: {
    background: codeOss.input.background,
    foreground: codeOss.input.foreground,
    placeholder: `color-mix(in srgb, ${codeOss.input.foreground} 40%, ${codeOss.input.background})`,
    border: border(codeOss.input.border),
    strongBorder: border(codeOss.input.strongBorder),
    radius: atoms.radius.md,
  },
  dropdown: {
    background: codeOss.dropdown.background,
    foreground: codeOss.dropdown.foreground,
    border: border(codeOss.dropdown.border),
    radius: atoms.radius.sm,
  },
  button: {
    background: codeOss.button.background,
    foreground: codeOss.button.foreground,
    hoverBackground: codeOss.button.hoverBackground,
    radius: atoms.radius.sm,
    secondary: {
      background: codeOss.button.secondaryBackground,
      foreground: codeOss.button.secondaryForeground,
      hoverBackground: codeOss.button.secondaryHoverBackground,
    },
    quiet: { hoverBackground: codeOss.toolbar.hoverBackground },
  },
  list: {
    hoverBackground: codeOss.list.hoverBackground,
    selected: {
      background: codeOss.list.activeSelectionBackground,
      foreground: codeOss.list.activeSelectionForeground,
    },
    radius: atoms.radius.sm,
  },
  review: { keepBackground: codeOss.review.keepBackground, keepForeground: codeOss.review.keepForeground },
  context: {
    file: { foreground: codeOss.context.fileForeground, background: tint(codeOss.context.fileForeground) },
    skill: { foreground: codeOss.context.skillForeground, background: tint(codeOss.context.skillForeground) },
  },
  syntax: {
    keyword: 'light-dark(#0000ff, #c586c0)',
    string: 'light-dark(#a31515, #ce9178)',
    number: 'light-dark(#098658, #b5cea8)',
    function: 'light-dark(#795e26, #dcdcaa)',
    type: 'light-dark(#267f99, #4ec9b0)',
    variable: 'light-dark(#001080, #9cdcfe)',
    comment: 'light-dark(#008000, #6a9955)',
  },
  diff: { added: codeOss.diff.added, removed: codeOss.diff.removed, renamed: codeOss.diff.renamed },
  card: { radius: atoms.radius.lg },
  badge: { radius: atoms.radius.xs },
  avatar: { radius: atoms.radius.round },
  progress: { foreground: codeOss.progressBar.background },
  history: {
    shadow: `-${atoms.space.xs}px 0 ${atoms.space.lg}px ${codeOss.widget.shadow}`,
    layer: 2,
    drawerWidth: 280,
    columnWidth: 260,
  },
} as const;

/** Shares the breakpoint between CSS container queries and DOM behavior. */
export const conditions = { widePane: `@container (min-width: ${tokens.layout.widePane}px)` } as const;
