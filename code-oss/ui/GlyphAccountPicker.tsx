import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { css } from './emotion.ts';

const styles = {
  root: css({
    padding: 12,
    borderTop: '1px solid var(--vscode-panel-border)',
    display: 'flex',
    gap: 10,
    alignItems: 'center',
  }),
  avatar: css({
    borderRadius: '50%',
    width: 30,
    height: 30,
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    fontSize: 12,
  }),
  identity: css({ minWidth: 0, flex: 1 }),
  select: css({
    width: '100%',
    minWidth: 0,
    font: 'inherit',
    color: 'var(--vscode-foreground)',
    background: 'var(--vscode-dropdown-background)',
    border: '1px solid var(--vscode-dropdown-border, transparent)',
    borderRadius: 4,
    padding: '5px 2px',
    ':focus-visible': { outline: '1px solid var(--vscode-focusBorder)' },
    ':disabled': { opacity: 1 },
  }),
  detail: css({ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginTop: 4, overflowWrap: 'anywhere' }),
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
