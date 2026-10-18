import { Sparkle } from 'lucide-preact';
import { css } from '#code-oss/ui/design-system/index.ts';
const style = css({
  position: 'relative',
  display: 'inline-block',
  flexShrink: 0,
  width: 14,
  height: 14,
  '& > svg': { position: 'absolute' },
  '& > svg:first-child': { left: 0, bottom: 0 },
  '& > svg:last-child': { right: 0, top: 0 },
});
export function GlyphAgentIcon() {
  return (
    <span class={`glyph-agent-icon ${style}`} aria-hidden="true">
      <Sparkle size={11} />
      <Sparkle size={6} />
    </span>
  );
}
