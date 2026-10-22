import { cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { aGlyphWorkbenchState } from '#src/desktop/tests/fixtures/aGlyphWorkbenchState.ts';
import { useGlyphAccountPickerState } from '#code-oss/ui/GlyphAccountPicker/useGlyphAccountPickerState.ts';

afterEach(cleanup);

const workbenchState = aGlyphWorkbenchState;

function accountActions(selectAccount = vi.fn(async () => {})) {
  return { selectAccount } as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions;
}

describe(useGlyphAccountPickerState, () => {
  it('invites choosing an account when none is selected', () => {
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: { state: workbenchState(), actions: accountActions() },
    });

    expect(result.current.selectedKey).toBe('');
    expect(result.current.avatar).toBe('G');
    expect(result.current.disabled).toBe(false);
    expect(result.current.unavailableLabel).toBe('No connected account');
    expect(result.current.detail).toBe('Choose an account for new chats');
    expect(result.current.loadingModels).toBe(false);
    expect(result.current.canRetry).toBe(false);
  });

  it('describes the selected account for new chats', () => {
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: {
        state: workbenchState({
          selectedAccount: { provider: 'openai', id: 'a1' },
          accounts: [
            { provider: 'openai', id: 'a1', label: 'pedro@example.com', connected: true, inferenceAccess: true },
            { provider: 'openai', id: 'a2', label: 'offline', connected: false, inferenceAccess: true },
            { provider: 'openai', id: 'a3', label: 'no access', connected: true, inferenceAccess: false },
          ],
        }),
        actions: accountActions(),
      },
    });

    expect(result.current.selectedKey).toBe('["openai","a1"]');
    expect(result.current.avatar).toBe('PE');
    expect(result.current.unavailableLabel).toBeUndefined();
    expect(result.current.detail).toBe('Connected account');
    expect(result.current.accounts).toEqual([
      { key: '["openai","a1"]', disabled: false, label: 'pedro@example.com' },
      { key: '["openai","a2"]', disabled: true, label: 'offline — unavailable' },
      { key: '["openai","a3"]', disabled: true, label: 'no access — unavailable' },
    ]);
  });

  it('locks the account of an open conversation', () => {
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: {
        state: workbenchState({
          selectedChatId: 'chat-1',
          selectedAccount: { provider: 'openai', id: 'a1' },
          catalogPending: true,
          chats: [
            {
              id: 'chat-1',
              title: 'Chat',
              accountProvider: 'openai',
              accountId: 'a2',
              modelSlug: 'gpt',
              updatedAt: '2026-01-01T00:00:00Z',
              turnCount: 1,
            },
          ],
          accounts: [{ provider: 'openai', id: 'a2', label: 'work', connected: true, inferenceAccess: true }],
        }),
        actions: accountActions(),
      },
    });

    expect(result.current.selectedKey).toBe('["openai","a2"]');
    expect(result.current.disabled).toBe(true);
    expect(result.current.detail).toBe('Account for this conversation');
    expect(result.current.loadingModels).toBe(false);
    expect(result.current.canRetry).toBe(false);
  });

  it('marks the account of a conversation as unavailable once it disconnects', () => {
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: {
        state: workbenchState({
          selectedChatId: 'chat-1',
          chats: [
            {
              id: 'chat-1',
              title: 'Chat',
              accountProvider: 'openai',
              accountId: 'gone',
              modelSlug: 'gpt',
              updatedAt: '2026-01-01T00:00:00Z',
              turnCount: 1,
            },
          ],
        }),
        actions: accountActions(),
      },
    });

    expect(result.current.unavailableLabel).toBe('Account unavailable');
  });

  it('disables switching while navigating or read only', () => {
    const navigating = renderHook(useGlyphAccountPickerState, {
      initialProps: { state: workbenchState({ navigationPending: true }), actions: accountActions() },
    });
    const readOnly = renderHook(useGlyphAccountPickerState, {
      initialProps: { state: workbenchState({ readOnly: true }), actions: accountActions() },
    });

    expect(navigating.result.current.disabled).toBe(true);
    expect(readOnly.result.current.disabled).toBe(true);
  });

  it('offers to retry while models load', () => {
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: {
        state: workbenchState({
          selectedAccount: { provider: 'openai', id: 'a1' },
          catalogPending: true,
          accounts: [{ provider: 'openai', id: 'a1', label: 'me', connected: true, inferenceAccess: true }],
        }),
        actions: accountActions(),
      },
    });

    expect(result.current.detail).toBe('Loading models…');
    expect(result.current.loadingModels).toBe(true);
    expect(result.current.canRetry).toBe(true);
  });

  it('offers to retry when models could not be loaded', () => {
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: {
        state: workbenchState({
          selectedAccount: { provider: 'openai', id: 'a1' },
          navigationError: 'Network down',
          accounts: [{ provider: 'openai', id: 'a1', label: 'me', connected: true, inferenceAccess: true }],
        }),
        actions: accountActions(),
      },
    });

    expect(result.current.detail).toBe('Models unavailable');
    expect(result.current.loadingModels).toBe(false);
    expect(result.current.canRetry).toBe(true);
  });

  it('keeps the connected state when a model is still selected despite an error', () => {
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: {
        state: workbenchState({
          selectedAccount: { provider: 'openai', id: 'a1' },
          navigationError: 'Network down',
          selectedModel: 'gpt',
          accounts: [{ provider: 'openai', id: 'a1', label: 'me', connected: true, inferenceAccess: true }],
        }),
        actions: accountActions(),
      },
    });

    expect(result.current.detail).toBe('Connected account');
    expect(result.current.canRetry).toBe(false);
  });

  it('cannot retry without an account', () => {
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: { state: workbenchState({ navigationError: 'Network down' }), actions: accountActions() },
    });

    expect(result.current.detail).toBe('Models unavailable');
    expect(result.current.canRetry).toBe(false);
  });

  it('selects known accounts and retries with the current account', () => {
    const selectAccount = vi.fn(async () => {});
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: {
        state: workbenchState({
          selectedAccount: { provider: 'openai', id: 'a1' },
          accounts: [
            { provider: 'openai', id: 'a1', label: 'me', connected: true, inferenceAccess: true },
            { provider: 'anthropic', id: 'b1', label: 'other', connected: true, inferenceAccess: true },
          ],
        }),
        actions: accountActions(selectAccount),
      },
    });

    result.current.selectAccount('["anthropic","b1"]');
    result.current.selectAccount('["missing","x"]');
    result.current.retryModels();

    expect(selectAccount.mock.calls).toEqual([
      ['anthropic', 'b1'],
      ['openai', 'a1'],
    ]);
  });

  it('does not retry without an account', () => {
    const selectAccount = vi.fn(async () => {});
    const { result } = renderHook(useGlyphAccountPickerState, {
      initialProps: { state: workbenchState(), actions: accountActions(selectAccount) },
    });

    result.current.retryModels();

    expect(selectAccount).not.toHaveBeenCalled();
  });
});
