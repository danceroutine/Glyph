import type { ComponentChildren } from 'preact';
import { ChevronRight } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

const styles = {
  summary: css({
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: 'fit-content',
    maxWidth: '100%',
    minHeight: 26,
    cursor: 'pointer',
    listStyle: 'none',
    userSelect: 'none',
    '&::-webkit-details-marker': { display: 'none' },
    '& > .glyph-tool-chevron': {
      opacity: 0,
      flexShrink: 0,
      color: tokens.text.muted,
      transition: 'opacity 100ms ease',
    },
    ':hover > .glyph-tool-chevron, :focus-visible > .glyph-tool-chevron': { opacity: 1 },
    ':focus-visible': { outline: tokens.focus.ring, outlineOffset: tokens.focus.offset },
    'details[open] > & > .glyph-tool-chevron': { transform: 'rotate(90deg)' },
    '@media (hover: none)': { '& > .glyph-tool-chevron': { opacity: 1 } },
  }),
  label: css({ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
  running: css({
    backgroundImage: `linear-gradient(100deg, ${tokens.text.muted} 43%, ${tokens.text.primary} 50%, ${tokens.text.muted} 57%)`,
    backgroundSize: '300% 100%',
    backgroundRepeat: 'no-repeat',
    backgroundClip: 'text',
    color: 'transparent',
    animation: 'glyph-tool-shimmer 1.8s linear infinite',
    '@keyframes glyph-tool-shimmer': { from: { backgroundPosition: '100% 0' }, to: { backgroundPosition: '0% 0' } },
    '@media (prefers-reduced-motion: reduce)': { animation: 'none', backgroundImage: 'none', color: tokens.text.muted },
    '@media (forced-colors: active)': { animation: 'none', backgroundImage: 'none', color: 'CanvasText' },
  }),
};

/** Shared native disclosure and running-state treatment for transcript tool activity. */
export function GlyphToolDisclosure({
  label,
  prefix,
  icon,
  running = false,
  class: className,
  children,
}: {
  readonly label: string;
  readonly prefix?: string;
  readonly icon?: ComponentChildren;
  readonly running?: boolean;
  readonly class?: string;
  readonly children: ComponentChildren;
}) {
  return (
    <details class={className}>
      <summary class={`${styles.summary} ${running ? styles.running : ''}`} title={label}>
        {prefix && <span>{prefix}</span>}
        {icon}
        <span class={styles.label}>{label}</span>
        <ChevronRight class="glyph-tool-chevron" size={14} aria-hidden="true" />
      </summary>
      {children}
    </details>
  );
}
