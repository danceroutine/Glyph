import { Check, Copy, TriangleAlert, WrapText } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import type { GlyphCodeBlockState } from './useGlyphCodeBlockState.ts';

const styles = {
  block: css({
    color: tokens.text.primary,
    colorScheme: 'dark',
    '.vs &, .hc-light &, [data-theme=light] &': { colorScheme: 'light' },
    margin: '12px 0',
    minWidth: 0,
    border: tokens.border.default,
    borderRadius: tokens.input.radius,
    overflow: 'hidden',
    background: tokens.surface.canvas,
  }),
  toolbar: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '4px 8px',
    borderBottom: tokens.border.default,
    color: tokens.text.muted,
    userSelect: 'none',
  }),
  // Keep decoration out of the message text so selection/annotation offsets stay stable.
  language: css({ fontSize: tokens.font.size.caption, '::before': { content: 'attr(data-language)' } }),
  actions: css({ display: 'flex', gap: 4 }),
  button: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    border: 0,
    borderRadius: tokens.button.radius,
    color: tokens.text.muted,
    background: 'transparent',
    cursor: 'pointer',
    ':hover': { color: tokens.text.primary, background: tokens.button.quiet.hoverBackground },
    ':focus-visible': { outline: tokens.focus.ring },
    '&[aria-pressed=true]': { color: tokens.text.primary, background: tokens.button.quiet.hoverBackground },
  }),
  code: css({
    margin: 0,
    padding: 12,
    overflowX: 'auto',
    tabSize: 2,
    fontFamily: tokens.font.family.code,
    fontSize: 'inherit',
    lineHeight: 1.6,
    '& code': { font: 'inherit' },
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
  }),
};
type HighlightNode = NonNullable<GlyphCodeBlockState['nodes']>[number];
function highlighted(nodes: readonly HighlightNode[]): ComponentChildren {
  return nodes.map(node =>
    node.type === 'text' ? (
      node.value
    ) : node.type === 'element' ? (
      <span class={Array.isArray(node.properties.className) ? node.properties.className.join(' ') : undefined}>
        {highlighted(node.children)}
      </span>
    ) : null,
  );
}
export function GlyphCodeBlock(state: GlyphCodeBlockState) {
  const copyLabel = state.error ? 'Copy failed. Try again' : state.copied ? 'Copied code' : 'Copy code';
  return (
    <div class={`glyph-code-block ${styles.block}`}>
      <div class={styles.toolbar} role="group" aria-label="Code block controls">
        <span class={styles.language} data-language={state.language} aria-label={state.language} />
        <div class={styles.actions}>
          <button
            class={styles.button}
            type="button"
            aria-label="Wrap code"
            title={state.wrap ? 'Disable text wrap' : 'Enable text wrap'}
            aria-pressed={state.wrap}
            onClick={state.toggleWrap}
          >
            <WrapText size={16} aria-hidden="true" />
          </button>
          <button
            class={styles.button}
            type="button"
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => void state.copy()}
          >
            {state.error ? (
              <TriangleAlert size={16} aria-hidden="true" />
            ) : state.copied ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      <pre
        class={styles.code}
        tabIndex={0}
        aria-label={`${state.language} code`}
        style={{ whiteSpace: state.wrap ? 'pre-wrap' : 'pre', overflowWrap: state.wrap ? 'anywhere' : 'normal' }}
      >
        <code>{state.nodes ? highlighted(state.nodes) : state.source}</code>
      </pre>
    </div>
  );
}
