import { Button, ButtonSize, ButtonVariant, ButtonAppearance } from '#code-oss/ui/Button/Button.tsx';
import type { GlyphAccountPickerState } from './useGlyphAccountPickerState.ts';
import { ChevronDown, RefreshCw } from 'lucide-preact';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';

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
  picker: css({
    position: 'relative',
    '&:hover select:enabled + svg, & select:focus-visible + svg': { opacity: 1 },
  }),
  caret: css({
    position: 'absolute',
    right: 0,
    top: '50%',
    transform: 'translateY(-50%)',
    color: tokens.text.muted,
    pointerEvents: 'none',
    opacity: 0,
  }),
  select: css({
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    appearance: 'none',
    textOverflow: 'ellipsis',
    cursor: 'pointer',
    font: 'inherit',
    color: tokens.text.primary,
    background: 'transparent',
    border: 0,
    borderRadius: tokens.input.radius,
    padding: '2px 20px 2px 0',
    '& option': { background: tokens.dropdown.background, color: tokens.dropdown.foreground },
    ':focus-visible': { outline: tokens.focus.ring },
    ':disabled': { opacity: 1, cursor: 'default' },
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
  loadingModels,
  selectAccount,
  retryModels,
}: GlyphAccountPickerProps) {
  return (
    <footer class={`glyph-account-picker ${styles.root}`}>
      <span class={styles.avatar} aria-hidden="true">
        {avatar}
      </span>
      <div class={styles.identity}>
        <div class={styles.picker}>
          <select
            class={styles.select}
            aria-label="Account"
            value={selectedKey}
            disabled={disabled}
            onChange={event => {
              selectAccount(event.currentTarget.value);
            }}
          >
            {unavailableLabel !== undefined && unavailableLabel !== '' && (
              <option value={selectedKey}>{unavailableLabel}</option>
            )}
            {accounts.map(account => (
              <option key={account.key} value={account.key} disabled={account.disabled}>
                {account.label}
              </option>
            ))}
          </select>
          <ChevronDown class={styles.caret} size={14} aria-hidden="true" />
        </div>
        <div class={styles.detail}>
          {canRetry ? (
            <Button
              variant={ButtonVariant.SECONDARY}
              appearance={ButtonAppearance.GHOST}
              size={ButtonSize.SMALL}
              leadingIcon={<RefreshCw size={14} aria-hidden="true" />}
              loadingIcon={<RefreshCw size={14} />}
              loading={loadingModels}
              disabled={disabled}
              title={loadingModels ? 'Loading models' : 'Retry loading models'}
              onClick={retryModels}
            >
              {loadingModels ? 'Loading models…' : 'Models unavailable'}
            </Button>
          ) : (
            detail
          )}
        </div>
      </div>
    </footer>
  );
}
