import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { css, tokens, space } from './design-system/index.ts';

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

export function GlyphAccountPicker({
  state,
  actions,
}: {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
}) {
  const chat = state.chats.find(value => value.id === state.selectedChatId);
  const identity = chat ? { provider: chat.accountProvider, id: chat.accountId } : state.selectedAccount;
  const account = state.accounts.find(value => value.provider === identity?.provider && value.id === identity.id);
  const key = identity ? JSON.stringify([identity.provider, identity.id]) : '';
  return (
    <footer class={`glyph-account-picker ${styles.root}`}>
      <span class={styles.avatar} aria-hidden="true">
        {account?.label.slice(0, 2).toUpperCase() ?? 'G'}
      </span>
      <div class={styles.identity}>
        <select
          class={styles.select}
          aria-label="Account"
          value={key}
          disabled={!!chat || state.navigationPending || state.readOnly}
          onChange={event => {
            const selected = state.accounts.find(
              value => JSON.stringify([value.provider, value.id]) === event.currentTarget.value,
            );
            if (selected) void actions.selectAccount(selected.provider, selected.id);
          }}
        >
          {!account && <option value={key}>{chat ? 'Account unavailable' : 'No connected account'}</option>}
          {state.accounts.map(value => (
            <option
              key={JSON.stringify([value.provider, value.id])}
              value={JSON.stringify([value.provider, value.id])}
              disabled={!value.connected || !value.inferenceAccess}
            >
              {value.label}
              {!value.connected || !value.inferenceAccess ? ' — unavailable' : ''}
            </option>
          ))}
        </select>
        <div class={styles.detail}>
          {chat
            ? 'Account for this conversation'
            : state.catalogPending
              ? 'Loading models…'
              : state.navigationError && !state.selectedModel
                ? 'Models unavailable'
                : account
                  ? 'Connected account'
                  : 'Choose an account for new chats'}
        </div>
        {!chat && account && !state.catalogPending && state.navigationError && !state.selectedModel && (
          <button
            type="button"
            onClick={() => {
              void actions.selectAccount(account.provider, account.id);
            }}
          >
            Retry models
          </button>
        )}
      </div>
    </footer>
  );
}
