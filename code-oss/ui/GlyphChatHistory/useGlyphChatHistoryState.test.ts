import { act, cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { aGlyphChatSummary } from '#src/desktop/tests/fixtures/aGlyphChatSummary.ts';
import { aGlyphRunProjection } from '#src/desktop/tests/fixtures/aGlyphRunProjection.ts';
import { aGlyphWorkbenchState } from '#src/desktop/tests/fixtures/aGlyphWorkbenchState.ts';
import { useGlyphChatHistoryState } from '#code-oss/ui/GlyphChatHistory/useGlyphChatHistoryState.ts';

afterEach(cleanup);

const workbenchState = aGlyphWorkbenchState;

const chat = (id: string, title: string, updatedAt: string) =>
  aGlyphChatSummary({ id, title, updatedAt, accountId: 'a1', modelSlug: 'gpt' });

const run = (chatId: string, status: GlyphRunStatus) =>
  aGlyphRunProjection({ chatId, runId: `${chatId}-${status}`, status });

function historyActions(overrides: Partial<GlyphWorkbenchViewActions> = {}) {
  return {
    newChat: vi.fn(),
    openChat: vi.fn(async () => {}),
    ...overrides,
  } as Partial<GlyphWorkbenchViewActions> as GlyphWorkbenchViewActions;
}

function freezeToday() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 20, 12));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

describe(useGlyphChatHistoryState, () => {
  it('keeps an unsent draft in history, opens it, and filters it by its first line', () => {
    const actions = historyActions();
    const { result } = renderHook(useGlyphChatHistoryState, {
      initialProps: {
        actions,
        state: workbenchState({
          newChatDraft: { text: '  Draft work\nMore context', createdAt: new Date().toISOString() },
        }),
      },
    });
    expect(result.current.emptyMessage).toBeUndefined();
    const draft = result.current.groups.flatMap(group => group.chats)[0]!;
    expect(draft).toMatchObject({ id: '', draft: true, title: 'Draft: Draft work', selected: true });
    act(() => {
      result.current.openChat('');
    });
    expect(actions.newChat).toHaveBeenCalledOnce();
    act(() => {
      result.current.setQuery('absent');
    });
    expect(result.current.groups.flatMap(group => group.chats)).toEqual([]);
    expect(result.current.emptyMessage).toBe('No matching chats.');
  });

  it('distinguishes unopened completed conversations from conversations without messages', () => {
    const { result } = renderHook(useGlyphChatHistoryState, {
      initialProps: {
        actions: historyActions(),
        state: workbenchState({
          chats: [aGlyphChatSummary({ id: 'empty', turnCount: 0 }), aGlyphChatSummary({ id: 'saved', turnCount: 1 })],
        }),
      },
    });
    expect(
      result.current.groups
        .flatMap(group => group.chats)
        .map(value => value.activity)
        .toSorted(),
    ).toEqual(['completed', 'empty']);
  });
  it('groups chats by pin and recency, newest first', () => {
    freezeToday();
    const { result } = renderHook(useGlyphChatHistoryState, {
      initialProps: {
        state: workbenchState({
          pinnedChatIds: ['pinned'],
          chats: [
            chat('older', 'Older chat', new Date(2026, 9, 10).toISOString()),
            chat('today-b', 'Today B', new Date(2026, 9, 20, 9).toISOString()),
            chat('today-a', 'Today A', new Date(2026, 9, 20, 9).toISOString()),
            chat('yesterday', 'Yesterday chat', new Date(2026, 9, 19, 18).toISOString()),
            chat('pinned', 'Pinned chat', new Date(2026, 8, 1).toISOString()),
          ],
        }),
        actions: historyActions(),
      },
    });

    expect(result.current.groups.map(group => [group.label, group.chats.map(value => value.id)])).toEqual([
      ['Pinned', ['pinned']],
      ['Today', ['today-a', 'today-b']],
      ['Yesterday', ['yesterday']],
      ['Older', ['older']],
    ]);
    expect(result.current.emptyMessage).toBeUndefined();
  });

  it('separates archived chats', () => {
    const { result } = renderHook(useGlyphChatHistoryState, {
      initialProps: {
        state: workbenchState({
          archivedChatIds: ['archived'],
          chats: [chat('archived', 'Archived', '2026-01-02T00:00:00Z'), chat('live', 'Live', '2026-01-01T00:00:00Z')],
        }),
        actions: historyActions(),
      },
    });

    expect(result.current.archived.map(value => value.id)).toEqual(['archived']);
    expect(result.current.groups.flatMap(group => group.chats).map(value => value.id)).toEqual(['live']);
    expect(result.current.archivedOpen).toBe(false);
    act(() => {
      result.current.toggleArchived();
    });
    expect(result.current.archivedOpen).toBe(true);
  });

  it('describes selected and running chats', () => {
    const { result } = renderHook(useGlyphChatHistoryState, {
      initialProps: {
        state: workbenchState({
          selectedChatId: 'streaming',
          chats: [
            chat('streaming', 'Streaming', '2026-01-04T00:00:00Z'),
            chat('question', 'Question', '2026-01-03T00:00:00Z'),
            chat('approval', 'Approval', '2026-01-02T00:00:00Z'),
            chat('done', 'Done', '2026-01-01T00:00:00Z'),
          ],
          runs: [
            run('streaming', GlyphRunStatus.STREAMING),
            run('question', GlyphRunStatus.WAITING_FOR_QUESTION),
            run('approval', GlyphRunStatus.WAITING_FOR_APPROVAL),
            run('done', GlyphRunStatus.COMPLETED),
          ],
        }),
        actions: historyActions(),
      },
    });

    const chats = result.current.groups.flatMap(group => group.chats);
    expect(chats.map(value => [value.id, value.activity, value.selected])).toEqual([
      ['streaming', 'working', true],
      ['question', 'awaiting_input', false],
      ['approval', 'awaiting_input', false],
      ['done', 'completed', false],
    ]);
  });

  it('filters chats by title ignoring case and surrounding space', () => {
    const { result } = renderHook(useGlyphChatHistoryState, {
      initialProps: {
        state: workbenchState({
          chats: [
            chat('a', 'Refactor Parser', '2026-01-02T00:00:00Z'),
            chat('b', 'Write docs', '2026-01-01T00:00:00Z'),
          ],
        }),
        actions: historyActions(),
      },
    });

    act(() => {
      result.current.setQuery('  parser ');
    });
    expect(result.current.groups.flatMap(group => group.chats).map(value => value.id)).toEqual(['a']);
    act(() => {
      result.current.setQuery('nothing');
    });

    expect(result.current.emptyMessage).toBe('No matching chats.');
  });

  it('explains where conversations will appear when there are none', () => {
    const { result } = renderHook(useGlyphChatHistoryState, {
      initialProps: { state: workbenchState(), actions: historyActions() },
    });

    expect(result.current.emptyMessage).toBe('Your conversations will appear here.');
    expect(result.current.newChatDisabled).toBe(false);
    expect(result.current.navigationPending).toBe(false);
  });

  it('disables new chats while navigating or read only', () => {
    const navigating = renderHook(useGlyphChatHistoryState, {
      initialProps: { state: workbenchState({ navigationPending: true }), actions: historyActions() },
    });
    const readOnly = renderHook(useGlyphChatHistoryState, {
      initialProps: { state: workbenchState({ readOnly: true }), actions: historyActions() },
    });

    expect(navigating.result.current.newChatDisabled).toBe(true);
    expect(navigating.result.current.navigationPending).toBe(true);
    expect(readOnly.result.current.newChatDisabled).toBe(true);
  });

  it('forwards chat actions', () => {
    const actions = historyActions({ setChatArchived: vi.fn(async () => {}), setChatPinned: vi.fn() });
    const { result } = renderHook(useGlyphChatHistoryState, {
      initialProps: { state: workbenchState(), actions },
    });

    result.current.newChat();
    result.current.openChat('chat-1');
    result.current.archive('chat-1', true);
    result.current.pin('chat-1', false);

    expect(actions.newChat).toHaveBeenCalledOnce();
    expect(actions.openChat).toHaveBeenCalledWith('chat-1');
    expect(actions.setChatArchived).toHaveBeenCalledWith('chat-1', true);
    expect(actions.setChatPinned).toHaveBeenCalledWith('chat-1', false);
  });

  it('tolerates hosts without archiving or pinning', () => {
    const { result } = renderHook(useGlyphChatHistoryState, {
      initialProps: { state: workbenchState(), actions: historyActions() },
    });

    expect(() => {
      result.current.archive('chat-1', true);
      result.current.pin('chat-1', true);
    }).not.toThrow();
  });
});
