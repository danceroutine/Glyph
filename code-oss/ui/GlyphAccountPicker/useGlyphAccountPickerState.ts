import type { GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';

export interface GlyphAccountPickerStateOptions {
  readonly state: GlyphWorkbenchState;
  readonly actions: GlyphWorkbenchViewActions;
}

export type GlyphAccountPickerState = ReturnType<typeof useGlyphAccountPickerState>;

export function useGlyphAccountPickerState({ state, actions }: GlyphAccountPickerStateOptions) {
  const chat = state.chats.find(value => value.id === state.selectedChatId);
  const identity = chat ? { provider: chat.accountProvider, id: chat.accountId } : state.selectedAccount;
  const account = state.accounts.find(value => value.provider === identity?.provider && value.id === identity.id);
  const selectedKey = identity ? JSON.stringify([identity.provider, identity.id]) : '';
  return {
    selectedKey,
    avatar: account?.label.slice(0, 2).toUpperCase() ?? 'G',
    disabled: !!chat || state.navigationPending || state.readOnly,
    unavailableLabel: account ? undefined : chat ? 'Account unavailable' : 'No connected account',
    accounts: state.accounts.map(value => ({
      key: JSON.stringify([value.provider, value.id]),
      disabled: !value.connected || !value.inferenceAccess,
      label: value.label + (!value.connected || !value.inferenceAccess ? ' — unavailable' : ''),
    })),
    detail: chat
      ? 'Account for this conversation'
      : state.catalogPending
        ? 'Loading models…'
        : state.navigationError && !state.selectedModel
          ? 'Models unavailable'
          : account
            ? 'Connected account'
            : 'Choose an account for new chats',
    canRetry: !!(!chat && account && !state.catalogPending && state.navigationError && !state.selectedModel),
    selectAccount: (key: string) => {
      const selected = state.accounts.find(value => JSON.stringify([value.provider, value.id]) === key);
      if (selected) void actions.selectAccount(selected.provider, selected.id);
    },
    retryModels: () => {
      if (account) void actions.selectAccount(account.provider, account.id);
    },
  };
}
