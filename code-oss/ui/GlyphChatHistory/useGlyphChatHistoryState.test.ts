import { act, cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphRunStatus, type GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import type { GlyphChatSummary } from '#src/desktop/protocol/events/GlyphChatSummary.js';
import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { useGlyphChatHistoryState } from '#code-oss/ui/GlyphChatHistory/useGlyphChatHistoryState.ts';

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

function chat(id: string, title: string, updatedAt: string): GlyphChatSummary {
  return { id, title, updatedAt, accountProvider: 'openai', accountId: 'a1', modelSlug: 'gpt', turnCount: 1 };
}

function run(chatId: string, status: GlyphRunStatus): GlyphRunProjection {
  return { chatId, runId: `${chatId}-${status}`, status, text: '', reasoning: '', tools: [] };
}

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
    act(() => result.current.toggleArchived());
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
    expect(chats.map(value => [value.id, value.active, value.selected])).toEqual([
      ['streaming', true, true],
      ['question', true, false],
      ['approval', true, false],
      ['done', false, false],
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

    act(() => result.current.setQuery('  parser '));
    expect(result.current.groups.flatMap(group => group.chats).map(value => value.id)).toEqual(['a']);
    act(() => result.current.setQuery('nothing'));

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
