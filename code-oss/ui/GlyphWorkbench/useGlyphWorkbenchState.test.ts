import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { GlyphChatSummary } from '#src/desktop/protocol/events/GlyphChatSummary.js';
import { GlyphProposalApplicability } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import type { GlyphProposalSummary } from '#src/desktop/protocol/events/GlyphProposalSummary.js';
import { GlyphRunStatus, type GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { tokens } from '#code-oss/ui/design-system/index.ts';
import { useGlyphWorkbenchState } from '#code-oss/ui/GlyphWorkbench/useGlyphWorkbenchState.ts';

const workbench = (overrides: Partial<GlyphWorkbenchState> = {}): GlyphWorkbenchState => ({
  status: GlyphWorkbenchStatus.READY,
  transcript: [],
  usage: {},
  accounts: [],
  models: [],
  chats: [],
  runs: [],
  proposals: [],
  ownerWindowId: 'window',
  readOnly: false,
  sequence: 0,
  ...overrides,
});

const chat = (overrides: Partial<GlyphChatSummary> = {}): GlyphChatSummary => ({
  id: 'chat',
  title: 'Refactor',
  accountProvider: 'openai',
  accountId: 'account',
  modelSlug: 'gpt-5',
  updatedAt: '2026-01-01T00:00:00.000Z',
  turnCount: 1,
  ...overrides,
});

const run = (overrides: Partial<GlyphRunProjection> = {}): GlyphRunProjection => ({
  chatId: 'chat',
  runId: 'run',
  status: GlyphRunStatus.COMPLETED,
  text: '',
  reasoning: '',
  tools: [],
  ...overrides,
});

const question = (id: string) => ({ id, title: 'Question', prompt: 'Why?' });

const proposal = (overrides: Partial<GlyphProposalSummary> = {}): GlyphProposalSummary => ({
  id: 'proposal',
  chatId: 'chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  files: [
    {
      id: 'file',
      path: 'a.ts',
      proposedUri: 'glyph://a',
      pendingItemIds: ['item'],
      applicability: GlyphProposalApplicability.READY,
    },
  ],
  ...overrides,
});

const workbenchActions = (overrides: Partial<GlyphWorkbenchViewActions> = {}) =>
  ({
    openChat: vi.fn(async () => {}),
    newChat: vi.fn(),
    ...overrides,
  }) as unknown as GlyphWorkbenchViewActions;

describe(useGlyphWorkbenchState, () => {
  it('shows a single new chat tab for an empty workbench', () => {
    const { result } = renderHook(useGlyphWorkbenchState, {
      initialProps: { state: workbench(), actions: workbenchActions() },
    });

    expect(result.current.tabs).toEqual([{ id: '', title: 'New chat', selected: true }]);
    expect(result.current.historyOpen).toBe(false);
    expect(result.current.todos).toEqual([]);
    expect(result.current.plans).toEqual([]);
    expect(result.current.plansDisabled).toBe(false);
    expect(result.current.proposals).toEqual([]);
    expect(result.current.newChatDisabled).toBeFalsy();
    expect(result.current.navigationError).toBeUndefined();
    expect(result.current.questionRun).toBeUndefined();
    expect(result.current.approvalRun).toBeUndefined();
    expect(result.current.initialAnswers).toEqual([]);
  });

  it('lists the open chat tabs with the selected chat marked', () => {
    const state = workbench({
      chats: [chat({ id: 'a', title: 'Alpha' }), chat({ id: 'b', title: 'Beta' })],
      openChatIds: ['a', 'b', ''],
      selectedChatId: 'b',
    });

    const { result } = renderHook(useGlyphWorkbenchState, { initialProps: { state, actions: workbenchActions() } });

    expect(result.current.tabs).toEqual([
      { id: 'a', title: 'Alpha', selected: false },
      { id: 'b', title: 'Beta', selected: true },
      { id: '', title: 'New chat', selected: false },
    ]);
  });

  it('shows the selected chat as the only tab when the window tracks no tabs', () => {
    const state = workbench({ chats: [chat({ id: 'a', title: 'Alpha' })], selectedChatId: 'a' });

    const { result } = renderHook(useGlyphWorkbenchState, { initialProps: { state, actions: workbenchActions() } });

    expect(result.current.tabs).toEqual([{ id: 'a', title: 'Alpha', selected: true }]);
  });

  it('opens chats, starts new chats and closes tabs through the host', () => {
    const closeChat = vi.fn(async () => {});
    const actions = workbenchActions({ closeChat });
    const { result } = renderHook(useGlyphWorkbenchState, { initialProps: { state: workbench(), actions } });

    result.current.selectTab('a');
    result.current.selectTab('');
    result.current.newChat();
    result.current.closeTab('a');

    expect(actions.openChat).toHaveBeenCalledWith('a');
    expect(actions.newChat).toHaveBeenCalledTimes(2);
    expect(closeChat).toHaveBeenCalledWith('a');
  });

  it('ignores closing tabs when the host cannot close chats', () => {
    const { result } = renderHook(useGlyphWorkbenchState, {
      initialProps: { state: workbench(), actions: workbenchActions() },
    });

    expect(() => {
      result.current.closeTab('a');
    }).not.toThrow();
  });

  it('exposes the todos, plans and pending proposals of the selected chat', () => {
    const plan = { id: 'plan', revision: 1, title: 'Plan', summary: '', markdown: '', todos: [], agents: [] };
    const todos = [{ id: 'todo', text: 'Ship', status: 'pending' as const }];
    const pending = proposal();
    const state = workbench({
      chats: [chat({ todos, plans: [plan] })],
      selectedChatId: 'chat',
      proposals: [
        pending,
        proposal({ id: 'other-chat', chatId: 'other' }),
        proposal({ id: 'decided', files: [{ ...pending.files[0]!, pendingItemIds: [] }] }),
      ],
    });

    const { result } = renderHook(useGlyphWorkbenchState, { initialProps: { state, actions: workbenchActions() } });

    expect(result.current.todos).toBe(todos);
    expect(result.current.plans).toEqual([plan]);
    expect(result.current.proposals).toEqual([pending]);
  });

  it.each([
    ['the window is read-only', { readOnly: true, runs: [] }],
    ['the chat is streaming', { runs: [run({ status: GlyphRunStatus.STREAMING })] }],
    ['the chat awaits an answer', { runs: [run({ status: GlyphRunStatus.WAITING_FOR_QUESTION })] }],
    ['the chat awaits an approval', { runs: [run({ status: GlyphRunStatus.WAITING_FOR_APPROVAL })] }],
  ])('disables plans while %s', (_, overrides) => {
    const state = workbench({ selectedChatId: 'chat', ...overrides });

    const { result } = renderHook(useGlyphWorkbenchState, { initialProps: { state, actions: workbenchActions() } });

    expect(result.current.plansDisabled).toBe(true);
  });

  it('keeps plans available while other chats run', () => {
    const state = workbench({
      selectedChatId: 'chat',
      runs: [run({ chatId: 'other', status: GlyphRunStatus.STREAMING }), run({ status: GlyphRunStatus.COMPLETED })],
    });

    const { result } = renderHook(useGlyphWorkbenchState, { initialProps: { state, actions: workbenchActions() } });

    expect(result.current.plansDisabled).toBe(false);
  });

  it.each([
    ['navigation is pending', { navigationPending: true }],
    ['the window is read-only', { readOnly: true }],
  ])('disables starting chats while %s', (_, overrides) => {
    const { result } = renderHook(useGlyphWorkbenchState, {
      initialProps: {
        state: workbench({ ...overrides, navigationError: 'Missing chat' }),
        actions: workbenchActions(),
      },
    });

    expect(result.current.newChatDisabled).toBe(true);
    expect(result.current.navigationError).toBe('Missing chat');
  });

  it('finds the selected chat runs awaiting a question or an approval', () => {
    const waiting = run({ runId: 'q', status: GlyphRunStatus.WAITING_FOR_QUESTION, question: question('ask') });
    const approving = run({ runId: 'a', status: GlyphRunStatus.WAITING_FOR_APPROVAL });
    const state = workbench({
      selectedChatId: 'chat',
      runs: [run({ chatId: 'other', status: GlyphRunStatus.WAITING_FOR_QUESTION }), waiting, approving],
    });

    const { result } = renderHook(useGlyphWorkbenchState, { initialProps: { state, actions: workbenchActions() } });

    expect(result.current.questionRun).toBe(waiting);
    expect(result.current.approvalRun).toBe(approving);
  });

  it('keeps question drafts until their question is no longer pending', () => {
    const answers = [{ questionId: 'ask', type: QuestionAnswerType.OTHER as const, text: 'Because' }];
    const waiting = workbench({
      selectedChatId: 'chat',
      runs: [run({ status: GlyphRunStatus.WAITING_FOR_QUESTION, question: question('ask') })],
    });
    const actions = workbenchActions();
    const { result, rerender } = renderHook(useGlyphWorkbenchState, { initialProps: { state: waiting, actions } });

    result.current.onDraftChange(answers);
    rerender({ state: { ...waiting, runs: [...waiting.runs] }, actions });
    expect(result.current.initialAnswers).toBe(answers);

    rerender({ state: workbench({ selectedChatId: 'chat' }), actions });
    rerender({ state: waiting, actions });
    expect(result.current.initialAnswers).toEqual([]);
  });

  it('ignores drafts without a pending question', () => {
    const state = workbench({
      selectedChatId: 'chat',
      runs: [run({ status: GlyphRunStatus.WAITING_FOR_QUESTION })],
    });
    const { result } = renderHook(useGlyphWorkbenchState, { initialProps: { state, actions: workbenchActions() } });

    result.current.onDraftChange([]);

    expect(result.current.questionRun).toBeDefined();
    expect(result.current.initialAnswers).toEqual([]);
  });

  it('reserves room for history while it is open', () => {
    const release = vi.fn();
    const reserveHistoryWidth = vi.fn(() => release);
    const { result } = renderHook(useGlyphWorkbenchState, {
      initialProps: { state: workbench(), actions: workbenchActions({ reserveHistoryWidth }) },
    });

    act(() => {
      result.current.toggleHistory();
    });
    expect(result.current.historyOpen).toBe(true);
    expect(reserveHistoryWidth).toHaveBeenCalledWith(tokens.history.columnWidth);

    act(() => {
      result.current.closeHistory();
    });
    expect(result.current.historyOpen).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('opens and closes history without a host that reserves room', () => {
    const { result } = renderHook(useGlyphWorkbenchState, {
      initialProps: { state: workbench(), actions: workbenchActions() },
    });

    act(() => {
      result.current.toggleHistory();
    });
    act(() => {
      result.current.toggleHistory();
    });

    expect(result.current.historyOpen).toBe(false);
  });
});
