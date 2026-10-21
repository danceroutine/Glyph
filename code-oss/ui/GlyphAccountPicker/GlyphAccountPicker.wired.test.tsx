import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { WiredGlyphAccountPicker } from '#code-oss/ui/GlyphAccountPicker/GlyphAccountPicker.wired.tsx';

afterEach(cleanup);

function workbenchState(overrides: Partial<GlyphWorkbenchState> = {}): GlyphWorkbenchState {
  return {
    status: GlyphWorkbenchStatus.READY,
    transcript: [],
    usage: {},
    accounts: [],
    models: [],
    chats: [],
    runs: [],
    proposals: [],
    ownerWindowId: 'window-1',
    readOnly: false,
    sequence: 0,
    ...overrides,
  };
}

describe(WiredGlyphAccountPicker, () => {
  it('lists accounts and switches to the chosen one', () => {
    const selectAccount = vi.fn(async () => {});
    render(
      <WiredGlyphAccountPicker
        state={workbenchState({
          selectedAccount: { provider: 'openai', id: 'a1' },
          accounts: [
            { provider: 'openai', id: 'a1', label: 'me@example.com', connected: true, inferenceAccess: true },
            { provider: 'openai', id: 'a2', label: 'team', connected: true, inferenceAccess: true },
            { provider: 'openai', id: 'a3', label: 'old', connected: false, inferenceAccess: false },
          ],
        })}
        actions={{ selectAccount } as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions}
      />,
    );

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Account' });
    expect(select.value).toBe('["openai","a1"]');
    expect([...select.options].map(option => [option.textContent, option.disabled])).toEqual([
      ['me@example.com', false],
      ['team', false],
      ['old — unavailable', true],
    ]);
    expect(screen.getByText('ME')).toBeTruthy();
    expect(screen.getByText('Connected account')).toBeTruthy();

    fireEvent.change(select, { target: { value: '["openai","a2"]' } });

    expect(selectAccount).toHaveBeenCalledWith('openai', 'a2');
  });

  it('shows a placeholder when no account is connected', () => {
    render(
      <WiredGlyphAccountPicker
        state={workbenchState()}
        actions={{ selectAccount: vi.fn() } as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions}
      />,
    );

    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Account' });
    expect([...select.options].map(option => option.textContent)).toEqual(['No connected account']);
    expect(screen.getByText('G')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('retries loading models after a failure', () => {
    const selectAccount = vi.fn(async () => {});
    render(
      <WiredGlyphAccountPicker
        state={workbenchState({
          selectedAccount: { provider: 'openai', id: 'a1' },
          navigationError: 'offline',
          accounts: [{ provider: 'openai', id: 'a1', label: 'me', connected: true, inferenceAccess: true }],
        })}
        actions={{ selectAccount } as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions}
      />,
    );

    const retry = screen.getByRole('button', { name: 'Models unavailable' });
    expect(retry.title).toBe('Retry loading models');
    fireEvent.click(retry);

    expect(selectAccount).toHaveBeenCalledWith('openai', 'a1');
  });

  it('shows models loading for the selected account', () => {
    render(
      <WiredGlyphAccountPicker
        state={workbenchState({
          selectedAccount: { provider: 'openai', id: 'a1' },
          catalogPending: true,
          accounts: [{ provider: 'openai', id: 'a1', label: 'me', connected: true, inferenceAccess: true }],
        })}
        actions={{ selectAccount: vi.fn() } as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions}
      />,
    );

    const loading = screen.getByRole<HTMLButtonElement>('button', { name: 'Loading models…' });
    expect(loading.title).toBe('Loading models');
    expect(loading.disabled).toBe(true);
    expect(loading.getAttribute('aria-busy')).toBe('true');
  });
});
