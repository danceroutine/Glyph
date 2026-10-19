import { IconButton } from '#code-oss/ui/Button/Button.tsx';
import { glyphSyntaxStyles } from '#code-oss/ui/GlyphSyntaxHighlighting/GlyphSyntaxStyles.ts';
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

  code: css({
    margin: 0,
    padding: 12,
    overflowX: 'auto',
    tabSize: 2,
    fontFamily: tokens.font.family.code,
    fontSize: 'inherit',
    lineHeight: 1.6,
    '& code': { font: 'inherit' },
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
          <IconButton
            type="button"
            aria-label="Wrap code"
            title={state.wrap ? 'Disable text wrap' : 'Enable text wrap'}
            aria-pressed={state.wrap}
            onClick={state.toggleWrap}
          >
            <WrapText size={16} aria-hidden="true" />
          </IconButton>
          <IconButton type="button" aria-label={copyLabel} title={copyLabel} onClick={() => void state.copy()}>
            {state.error ? (
              <TriangleAlert size={16} aria-hidden="true" />
            ) : state.copied ? (
              <Check size={16} aria-hidden="true" />
            ) : (
              <Copy size={16} aria-hidden="true" />
            )}
          </IconButton>
        </div>
      </div>
      <pre
        class={`${styles.code} ${glyphSyntaxStyles}`}
        tabIndex={0}
        aria-label={`${state.language} code`}
        style={{ whiteSpace: state.wrap ? 'pre-wrap' : 'pre', overflowWrap: state.wrap ? 'anywhere' : 'normal' }}
      >
        <code>{state.nodes ? highlighted(state.nodes) : state.source}</code>
      </pre>
    </div>
  );
}
