import type { GlyphAccountPickerState } from './useGlyphAccountPickerState.ts';
import { css, tokens, space } from '#code-oss/ui/design-system/index.ts';

const styles = {
  root: css({
    padding: tokens.space.lg,
    borderTop: tokens.border.default,
    display: 'flex',
    gap: tokens.space.md,
    alignItems: 'center',
  }),
  avatar: css({
    borderRadius: tokens.avatar.radius,
    width: 30,
    height: 30,
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    background: tokens.button.secondary.background,
    color: tokens.button.secondary.foreground,
    fontSize: tokens.font.size.detail,
  }),
  identity: css({ minWidth: 0, flex: 1 }),
  select: css({
    width: '100%',
    minWidth: 0,
    font: 'inherit',
    color: tokens.dropdown.foreground,
    background: tokens.dropdown.background,
    border: tokens.dropdown.border,
    borderRadius: tokens.dropdown.radius,
    padding: space('xs', 'xxs'),
    ':focus-visible': { outline: tokens.focus.ring },
    ':disabled': { opacity: 1 },
  }),
  detail: css({
    fontSize: tokens.font.size.caption,
    color: tokens.text.muted,
    marginTop: tokens.space.xs,
    overflowWrap: 'anywhere',
  }),
};

export type GlyphAccountPickerProps = GlyphAccountPickerState;

export function GlyphAccountPicker({
  selectedKey,
  avatar,
  disabled,
  unavailableLabel,
  accounts,
  detail,
  canRetry,
  selectAccount,
  retryModels,
}: GlyphAccountPickerProps) {
  return (
    <footer class={`glyph-account-picker ${styles.root}`}>
      <span class={styles.avatar} aria-hidden="true">
        {avatar}
      </span>
      <div class={styles.identity}>
        <select
          class={styles.select}
          aria-label="Account"
          value={selectedKey}
          disabled={disabled}
          onChange={event => selectAccount(event.currentTarget.value)}
        >
          {unavailableLabel && <option value={selectedKey}>{unavailableLabel}</option>}
          {accounts.map(account => (
            <option key={account.key} value={account.key} disabled={account.disabled}>
              {account.label}
            </option>
          ))}
        </select>
        <div class={styles.detail}>{detail}</div>
        {canRetry && (
          <button type="button" onClick={retryModels}>
            Retry models
          </button>
        )}
      </div>
    </footer>
  );
}
