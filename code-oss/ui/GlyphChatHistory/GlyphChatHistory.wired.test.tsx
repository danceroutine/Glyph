import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { aGlyphChatSummary } from '#src/desktop/tests/fixtures/aGlyphChatSummary.ts';
import { aGlyphRunProjection } from '#src/desktop/tests/fixtures/aGlyphRunProjection.ts';
import { aGlyphWorkbenchState } from '#src/desktop/tests/fixtures/aGlyphWorkbenchState.ts';
import { WiredGlyphChatHistory } from '#code-oss/ui/GlyphChatHistory/GlyphChatHistory.wired.tsx';

afterEach(cleanup);

const workbenchState = aGlyphWorkbenchState;

const chat = (id: string, title: string, updatedAt = '2026-01-01T00:00:00Z') =>
  aGlyphChatSummary({ id, title, updatedAt, accountId: 'a1', modelSlug: 'gpt' });

function historyActions() {
  return {
    newChat: vi.fn(),
    openChat: vi.fn(async () => {}),
    setChatArchived: vi.fn(async () => {}),
    setChatPinned: vi.fn(),
    selectAccount: vi.fn(async () => {}),
  } as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions;
}

describe(WiredGlyphChatHistory, () => {
  it('labels a saved conversation that has no messages yet', () => {
    render(
      <WiredGlyphChatHistory
        state={workbenchState({ chats: [{ ...chat('empty', 'Empty chat'), turnCount: 0 }] })}
        actions={historyActions()}
      />,
    );
    expect(screen.getByRole('img', { name: 'No messages yet' })).toBeTruthy();
  });
  it.each([
    GlyphRunStatus.WAITING_FOR_QUESTION,
    GlyphRunStatus.CANCELLED,
    GlyphRunStatus.INTERRUPTED,
    GlyphRunStatus.FAILED,
  ])('renders the history status %s', status => {
    render(
      <WiredGlyphChatHistory
        state={workbenchState({
          chats: [chat('status', 'Status chat')],
          runs: [aGlyphRunProjection({ chatId: 'status', status })],
          newChatDraft: { text: 'Unsent', createdAt: new Date().toISOString() },
        })}
        actions={historyActions()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Status chat' }).querySelector('[data-activity]')?.getAttribute('aria-label'),
    ).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Draft' })).toBeTruthy();
  });
  it('shows a sidebar with search, new chat, saved chats and the account picker', () => {
    const close = vi.fn();
    const toggleRef = createRef<HTMLButtonElement>();
    const actions = historyActions();
    render(
      <WiredGlyphChatHistory
        state={workbenchState({
          selectedChatId: 'running',
          pinnedChatIds: ['pinned'],
          chats: [chat('running', 'Running chat', '2026-01-02T00:00:00Z'), chat('pinned', 'Pinned chat')],
          runs: [aGlyphRunProjection({ chatId: 'running', runId: 'r', status: GlyphRunStatus.STREAMING })],
        })}
        actions={actions}
        close={close}
        toggleRef={toggleRef}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search chats' }));
    const toggle = screen.getByRole('button', { name: 'Chat history' });
    expect(toggleRef.current).toBe(toggle);
    fireEvent.click(toggle);
    expect(close).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '＋ New chat' }));
    expect(actions.newChat).toHaveBeenCalledOnce();
    expect(screen.getByRole('combobox', { name: 'Account' })).toBeTruthy();

    const pinned = screen.getByRole('region', { name: 'Pinned' });
    expect(within(pinned).getByRole('button', { name: 'Pinned chat' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Yesterday' })).toBeNull();
    const running = screen.getByRole('button', { name: 'Running chat' });
    expect(running.getAttribute('aria-current')).toBe('true');
    expect(Object.hasOwn(running.parentElement!.dataset, 'selected')).toBe(true);
    expect(within(running).getByRole('img', { name: 'Working' }).tagName).toBe('SPAN');
    expect(screen.getByRole('button', { name: 'Pinned chat' }).textContent).toBe('Pinned chat');
  });

  it('opens, pins, unpins and archives chats', () => {
    const actions = historyActions();
    render(
      <WiredGlyphChatHistory
        state={workbenchState({
          pinnedChatIds: ['pinned'],
          chats: [chat('loose', 'Loose chat'), chat('pinned', 'Pinned chat')],
        })}
        actions={actions}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Loose chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin Loose chat', hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Pinned chat', hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive Loose chat', hidden: true }));

    expect(actions.openChat).toHaveBeenCalledWith('loose');
    expect(actions.setChatPinned).toHaveBeenCalledWith('loose', true);
    expect(actions.setChatPinned).toHaveBeenCalledWith('pinned', false);
    expect(actions.setChatArchived).toHaveBeenCalledWith('loose', true);
    expect(screen.getByRole('button', { name: 'Pin Loose chat', hidden: true }).title).toBe('Pin chat');
    expect(screen.getByRole('button', { name: 'Unpin Pinned chat', hidden: true }).title).toBe('Unpin chat');
    expect(screen.getByRole('button', { name: 'Archive Loose chat', hidden: true }).title).toBe('Archive chat');
  });

  it('reveals archived chats on demand', () => {
    const actions = historyActions();
    render(
      <WiredGlyphChatHistory
        state={workbenchState({ archivedChatIds: ['old'], chats: [chat('old', 'Old chat')] })}
        actions={actions}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Archived (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Archived chats' })).toBeNull();

    fireEvent.click(toggle);

    const archived = screen.getByRole('region', { name: 'Archived chats' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(archived).queryByRole('button', { name: /^Pin/u, hidden: true })).toBeNull();
    const restore = within(archived).getByRole('button', { name: 'Unarchive Old chat', hidden: true });
    expect(restore.title).toBe('Unarchive chat');
    fireEvent.click(restore);
    expect(actions.setChatArchived).toHaveBeenCalledWith('old', false);
    expect(screen.getByText('Your conversations will appear here.')).toBeTruthy();
  });

  it('says when nothing is archived', () => {
    render(
      <WiredGlyphChatHistory state={workbenchState({ chats: [chat('a', 'A chat')] })} actions={historyActions()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));

    expect(screen.getByText('No archived chats.')).toBeTruthy();
  });

  it('filters chats from the search box', () => {
    render(
      <WiredGlyphChatHistory
        state={workbenchState({ chats: [chat('a', 'Alpha'), chat('b', 'Beta')] })}
        actions={historyActions()}
      />,
    );

    fireEvent.input(screen.getByRole('searchbox', { name: 'Search chats' }), { target: { value: 'zzz' } });

    expect(screen.getByText('No matching chats.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull();
  });

  it('omits the toolbar, new chat and account picker when compact', () => {
    render(
      <WiredGlyphChatHistory
        state={workbenchState({ chats: [chat('a', 'Alpha')] })}
        actions={historyActions()}
        compact
        close={vi.fn()}
      />,
    );

    expect(screen.getByRole('complementary', { name: 'Chat history' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Chat history' })).toBeNull();
    expect(screen.queryByRole('button', { name: '＋ New chat' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Account' })).toBeNull();
  });

  it('omits the close control when it cannot be closed', () => {
    render(<WiredGlyphChatHistory state={workbenchState()} actions={historyActions()} />);

    expect(screen.queryByRole('button', { name: 'Chat history' })).toBeNull();
  });

  it('disables navigation while a chat is opening', () => {
    render(
      <WiredGlyphChatHistory
        state={workbenchState({ navigationPending: true, chats: [chat('a', 'Alpha')] })}
        actions={historyActions()}
        close={vi.fn()}
      />,
    );

    expect(screen.getByRole('navigation', { name: 'Saved chats' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Alpha' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '＋ New chat' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Archive Alpha', hidden: true }).disabled).toBe(true);
  });
});
