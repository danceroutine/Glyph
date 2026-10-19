import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const badge = css({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  minWidth: 16,
  height: 16,
  borderRadius: tokens.badge.radius,
  fontSize: tokens.font.size.caption,
  fontWeight: tokens.font.weight.semibold,
  color: tokens.diff.renamed,
  background: `color-mix(in srgb, ${tokens.diff.renamed} 18%, transparent)`,
});

export function GlyphRenameBadge() {
  return (
    <span class={badge} title="Renamed" aria-label="Renamed">
      R
    </span>
  );
}
