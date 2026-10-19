import { css, tokens } from '#code-oss/ui/design-system/index.ts';

/** Shared token colors for editable and rendered code, in either theme. */
export const glyphSyntaxStyles = css({
  colorScheme: 'dark',
  '.vs &, .hc-light &, [data-theme=light] &': { colorScheme: 'light' },
  '& .hljs-keyword, & .hljs-selector-tag, & .hljs-meta': { color: tokens.syntax.keyword },
  '& .hljs-string, & .hljs-regexp, & .hljs-template-tag': { color: tokens.syntax.string },
  '& .hljs-number, & .hljs-literal': { color: tokens.syntax.number },
  '& .hljs-title, & .hljs-section': { color: tokens.syntax.function },
  '& .hljs-type, & .hljs-built_in, & .hljs-title.class_': { color: tokens.syntax.type },
  '& .hljs-attr, & .hljs-property, & .hljs-attribute, & .hljs-variable': { color: tokens.syntax.variable },
  '& .hljs-comment, & .hljs-quote': { color: tokens.syntax.comment },
  '& .hljs-name, & .hljs-tag': { color: tokens.syntax.keyword },
  '& .hljs-addition': { color: tokens.diff.added },
  '& .hljs-deletion': { color: tokens.diff.removed },
});
