import type { ComponentChildren, ButtonHTMLAttributes, CSSProperties, Ref, Signalish } from 'preact';
import { LoaderCircle } from 'lucide-preact';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { AGENT_MODE_PRESENTATION } from '#code-oss/ui/AgentMode/AgentModePresentation.tsx';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

export enum ButtonVariant {
  PRIMARY = 'primary',
  CONFIRM = 'confirm',
  SECONDARY = 'secondary',
}
export enum ButtonAppearance {
  FILLED = 'filled',
  OUTLINE = 'outline',
  GHOST = 'ghost',
  BORDERLESS_GHOST = 'borderless-ghost',
}
export enum ButtonSize {
  SMALL = 'small',
  MEDIUM = 'medium',
  LARGE = 'large',
}
export enum IconButtonShape {
  SQUARE = 'square',
  CIRCLE = 'circle',
}
export enum ButtonLoadingPosition {
  LEADING = 'leading',
  TRAILING = 'trailing',
}

const base = css({
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  gap: 4,
  minHeight: 'var(--button-size)',
  padding: '3px 8px',
  border: '1px solid transparent',
  borderRadius: tokens.button.radius,
  font: 'inherit',
  lineHeight: 1.25,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  background: 'var(--button-fill)',
  color: 'var(--button-foreground)',
  '& svg': { display: 'block', flexShrink: 0 },
  '&:hover:not(:disabled)': { background: 'var(--button-hover)' },
  '&[aria-pressed=true]:not(:disabled)': {
    background: 'var(--button-hover)',
    boxShadow: `inset 0 0 0 1px ${tokens.focus.color}`,
  },
  '&:focus-visible': { outline: tokens.focus.ring, outlineOffset: 2 },
  '&:disabled': { opacity: tokens.opacity.disabled, cursor: 'default' },
  '&[data-appearance=outline]': {
    background: 'transparent',
    borderColor: 'var(--button-fill)',
    color: tokens.text.primary,
    '&:hover:not(:disabled), &[aria-pressed=true]:not(:disabled)': { background: 'var(--button-tint)' },
  },
  '&[data-appearance=ghost]': {
    background: 'transparent',
    color: tokens.text.muted,
    '&:hover:not(:disabled), &[aria-pressed=true]:not(:disabled)': {
      background: 'var(--button-tint)',
      color: tokens.text.primary,
    },
  },
  '&[data-appearance=borderless-ghost]': {
    background: 'transparent',
    borderColor: 'transparent',
    color: tokens.text.muted,
    '&:hover:not(:disabled), &[aria-pressed=true]:not(:disabled)': {
      background: 'transparent',
      boxShadow: 'none',
      color: tokens.text.primary,
    },
  },
  '&[data-size=small]': { '--button-size': '24px', padding: '2px 6px' },
  '&[data-size=medium]': { '--button-size': '28px' },
  '&[data-size=large]': { '--button-size': '32px', padding: '5px 12px' },
  '&[data-icon-button]': {
    width: 'var(--button-size)',
    height: 'var(--button-size)',
    padding: 0,
    '& svg': {
      width: 'min(var(--button-icon-size, 20px), calc(var(--button-size) - 8px))',
      height: 'min(var(--button-icon-size, 20px), calc(var(--button-size) - 8px))',
    },
  },
  '&[data-shape=circle]': { borderRadius: '50%' },
});
const iconSlot = css({ display: 'inline-flex', alignItems: 'center' });
const shortcutStyle = css({ font: 'inherit', opacity: 0.7 });
const spinner = css({
  '@keyframes glyph-button-spin': { to: { transform: 'rotate(360deg)' } },
  animation: 'glyph-button-spin 900ms linear infinite',
  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
});

export function isOn(value: Signalish<boolean | undefined>): boolean {
  return (typeof value === 'object' ? value.value : value) === true;
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes, 'size' | 'ref' | 'style'> {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly style?: CSSProperties;
  readonly variant?: ButtonVariant;
  readonly appearance?: ButtonAppearance;
  readonly size?: ButtonSize;
  /** Only Primary changes palette with the mode. */
  readonly mode?: AgentModeID;
  readonly leadingIcon?: ComponentChildren;
  readonly trailingIcon?: ComponentChildren;
  /** A label resolved by the host's keybinding service, rather than a hardcoded shortcut. */
  readonly shortcut?: ComponentChildren;
  readonly loading?: boolean;
  /** Replaces the default spinner glyph; the button supplies the rotation. */
  readonly loadingIcon?: ComponentChildren;
  readonly loadingPosition?: ButtonLoadingPosition;
}

export function Button({
  variant = ButtonVariant.SECONDARY,
  appearance = ButtonAppearance.FILLED,
  size = ButtonSize.MEDIUM,
  mode = AgentModeID.AGENT,
  leadingIcon,
  trailingIcon,
  shortcut,
  loading = false,
  loadingIcon,
  loadingPosition = ButtonLoadingPosition.LEADING,
  children,
  class: className,
  style,
  buttonRef,
  disabled,
  type = 'button',
  ...props
}: ButtonProps) {
  const palette =
    variant === ButtonVariant.PRIMARY
      ? AGENT_MODE_PRESENTATION[mode].button
      : variant === ButtonVariant.CONFIRM
        ? {
            background: tokens.review.keepBackground,
            foreground: tokens.review.keepForeground,
            hover: tokens.review.keepBackground,
          }
        : {
            background: tokens.button.secondary.background,
            foreground: tokens.button.secondary.foreground,
            hover: tokens.button.secondary.hoverBackground,
          };
  const spinnerSlot = (
    <span class={`${iconSlot} ${spinner}`} aria-hidden="true">
      {loadingIcon ?? <LoaderCircle size={16} />}
    </span>
  );
  const leading = loading && loadingPosition === ButtonLoadingPosition.LEADING;
  const trailing = loading && loadingPosition === ButtonLoadingPosition.TRAILING;
  return (
    <button
      {...props}
      ref={buttonRef ?? null}
      type={type}
      class={`${base} ${(typeof className === 'object' ? className.value : className) ?? ''}`}
      disabled={isOn(disabled) || loading}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-appearance={appearance}
      data-size={size}
      style={{
        '--button-fill': palette.background,
        '--button-foreground': palette.foreground,
        '--button-hover': palette.hover,
        '--button-tint':
          variant === ButtonVariant.SECONDARY
            ? tokens.button.quiet.hoverBackground
            : `color-mix(in srgb, ${palette.background} 16%, transparent)`,
        ...(typeof style === 'object' ? style : {}),
      }}
    >
      {leading
        ? spinnerSlot
        : Boolean(leadingIcon) && (
            <span class={iconSlot} aria-hidden="true">
              {leadingIcon}
            </span>
          )}
      {children}
      {Boolean(shortcut) && <kbd class={shortcutStyle}>{shortcut}</kbd>}
      {trailing
        ? spinnerSlot
        : Boolean(trailingIcon) && (
            <span class={iconSlot} aria-hidden="true">
              {trailingIcon}
            </span>
          )}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'leadingIcon' | 'trailingIcon' | 'shortcut'> {
  readonly 'aria-label': string;
  readonly shape?: IconButtonShape;
  readonly iconSize?: number;
}
export function IconButton({
  shape = IconButtonShape.SQUARE,
  appearance = ButtonAppearance.GHOST,
  children,
  loading = false,
  iconSize,
  style = {},
  ...props
}: IconButtonProps) {
  return (
    <Button
      {...props}
      loading={loading}
      appearance={appearance}
      data-icon-button
      data-shape={shape}
      style={{
        ...(iconSize === undefined ? {} : { '--button-icon-size': `${iconSize}px` }),
        ...style,
      }}
    >
      {!loading && (
        <span class={iconSlot} aria-hidden="true">
          {children}
        </span>
      )}
    </Button>
  );
}
