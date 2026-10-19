import { Globe, Wrench } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const badge = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 17,
  height: 17,
  borderRadius: 4,
  background: tokens.button.secondary.background,
  border: tokens.border.default,
  boxSizing: 'border-box',
  color: tokens.text.muted,
});

export function GlyphToolIcon({ web = false }: { readonly web?: boolean }) {
  const Icon = web ? Globe : Wrench;
  return (
    <span class={badge} aria-hidden="true">
      <Icon size={12} strokeWidth={1.5} />
    </span>
  );
}
