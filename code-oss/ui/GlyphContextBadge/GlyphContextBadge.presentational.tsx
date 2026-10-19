import { Button, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import { FileText } from 'lucide-preact';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';
const styles = {
  badge: css({
    '&&': {
      minHeight: 0,
      verticalAlign: 'baseline',
      gap: tokens.space.xs,
      border: 0,
      borderRadius: tokens.badge.radius,
      padding: space('xxs', 'sm'),
      margin: space('none', 'xxs'),
      color: tokens.context.file.foreground,
      background: tokens.context.file.background,
    },
  }),
  skill: css({ '&&': { color: tokens.context.skill.foreground, background: tokens.context.skill.background } }),
};
export interface GlyphContextBadgeProps {
  readonly label: string;
  readonly title: string;
  readonly skill?: boolean;
  readonly actionLabel?: 'Preview' | 'Open';
  readonly onClick?: () => void;
}
export function GlyphContextBadge({ label, title, skill, onClick, actionLabel = 'Preview' }: GlyphContextBadgeProps) {
  return (
    <Button
      appearance={ButtonAppearance.GHOST}
      type="button"
      class={`${styles.badge} ${skill ? styles.skill : ''}`}
      title={title}
      aria-label={`${actionLabel} ${title}`}
      onClick={onClick}
    >
      {!skill && <FileText size={14} aria-hidden="true" />}
      {skill ? '/' : ''}
      {label}
    </Button>
  );
}
