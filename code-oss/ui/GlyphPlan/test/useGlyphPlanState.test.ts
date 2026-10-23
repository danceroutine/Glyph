import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { GlyphPlanRecord } from '#src/desktop/protocol/events/GlyphPlanRecord.js';
import type { GlyphPlanViewState } from '#src/desktop/workbench/GlyphPlanView.js';
import { aGlyphPlan } from '#src/desktop/tests/fixtures/aGlyphPlan.ts';
import { useGlyphPlanState } from '#code-oss/ui/GlyphPlan/useGlyphPlanState.ts';

const plan = (overrides: Partial<GlyphPlanRecord> = {}): GlyphPlanRecord =>
  aGlyphPlan({
    revision: 2,
    title: 'Ship it',
    summary: 'Summary',
    markdown: '# Ship it',
    todos: [
      { id: 'a', text: 'First', completed: false },
      { id: 'b', text: 'Second', completed: true },
    ],
    agents: [],
    ...overrides,
  });

const viewState = (overrides: Partial<GlyphPlanViewState> = {}): GlyphPlanViewState => ({
  plan: plan(),
  disabled: false,
  agents: [],
  ...overrides,
});

const planActions = () => ({
  update: vi.fn(async (_plan: GlyphPlanRecord) => {}),
  setTodo: vi.fn(async (_id: string, _completed: boolean) => {}),
  build: vi.fn(async (_newChat?: boolean) => {}),
  stopBuild: vi.fn(async () => {}),
  newAgent: vi.fn(async () => {}),
  openChat: vi.fn(async (_id: string) => {}),
  openLink: vi.fn(async (_href: string) => {}),
});

describe(useGlyphPlanState, () => {
  it('does not submit another build while the plan is already building', async () => {
    const actions = planActions();
    const { result } = renderHook(useGlyphPlanState, {
      initialProps: { state: viewState({ building: true }), actions },
    });
    await act(() => result.current.build());
    await act(() => result.current.buildNew());
    expect(result.current.building).toBe(true);
    expect(actions.build).not.toHaveBeenCalled();
  });
  it('exposes the plan view with an idle todo draft', () => {
    const state = viewState({ modelLabel: 'GPT-5' });

    const { result } = renderHook(useGlyphPlanState, { initialProps: { state, actions: planActions() } });

    expect(result.current.plan).toBe(state.plan);
    expect(result.current.modelLabel).toBe('GPT-5');
    expect(result.current.disabled).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.todo).toBe('');
    expect(result.current.adding).toBe(false);
  });

  it('starts adding a todo and tracks its draft', () => {
    const { result } = renderHook(useGlyphPlanState, { initialProps: { state: viewState(), actions: planActions() } });

    act(() => {
      result.current.add();
    });
    act(() => {
      result.current.setTodo('Draft');
    });

    expect(result.current.adding).toBe(true);
    expect(result.current.todo).toBe('Draft');
  });

  it('saves a trimmed todo as a pending item at the end of the plan', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('1-2-3-4-5');
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const actions = planActions();
    const state = viewState();
    const { result } = renderHook(useGlyphPlanState, { initialProps: { state, actions } });
    act(() => {
      result.current.add();
    });
    act(() => {
      result.current.setTodo('  Third  ');
    });

    await act(() => result.current.saveTodo());

    expect(actions.update).toHaveBeenCalledWith({
      ...state.plan,
      todos: [...state.plan.todos, { id: '1-2-3-4-5', text: 'Third', completed: false }],
    });
    expect(result.current.todo).toBe('');
    expect(result.current.adding).toBe(false);
  });

  it('does not save a blank todo', async () => {
    const actions = planActions();
    const { result } = renderHook(useGlyphPlanState, { initialProps: { state: viewState(), actions } });
    act(() => {
      result.current.add();
    });
    act(() => {
      result.current.setTodo('   ');
    });

    await act(() => result.current.saveTodo());

    expect(actions.update).not.toHaveBeenCalled();
    expect(result.current.adding).toBe(true);
  });

  it('toggles the completion of one todo', async () => {
    const actions = planActions();
    const state = viewState();
    const { result } = renderHook(useGlyphPlanState, { initialProps: { state, actions } });

    await act(() => result.current.toggleTodo('b'));

    expect(actions.setTodo).toHaveBeenCalledWith('b', false);
    expect(actions.update).not.toHaveBeenCalled();
  });

  it('can stop an active build even while the plan is otherwise disabled', async () => {
    const actions = planActions();
    const { result } = renderHook(useGlyphPlanState, {
      initialProps: { state: viewState({ building: true, disabled: true }), actions },
    });

    await act(() => result.current.stop());

    expect(actions.stopBuild).toHaveBeenCalledOnce();
  });

  it('builds the plan here or in a new chat', async () => {
    const actions = planActions();
    const { result } = renderHook(useGlyphPlanState, { initialProps: { state: viewState(), actions } });

    await act(() => result.current.build());
    await act(() => result.current.buildNew());

    expect(actions.build.mock.calls).toEqual([[], [true]]);
  });

  it('starts new agents and opens chats and links through the host', async () => {
    const actions = planActions();
    const { result } = renderHook(useGlyphPlanState, { initialProps: { state: viewState(), actions } });

    await act(() => result.current.newAgent());
    await act(() => result.current.openChat('chat'));
    await act(async () => {
      result.current.openLink('https://example.com');
    });

    expect(actions.newAgent).toHaveBeenCalledOnce();
    expect(actions.openChat).toHaveBeenCalledWith('chat');
    expect(actions.openLink).toHaveBeenCalledWith('https://example.com');
  });

  it('is disabled and ignores actions while one is pending', async () => {
    const actions = planActions();
    let finish!: () => void;
    actions.build.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(useGlyphPlanState, { initialProps: { state: viewState(), actions } });

    let first!: Promise<void>;
    act(() => {
      first = result.current.build();
    });
    expect(result.current.disabled).toBe(true);

    await act(() => result.current.newAgent());
    expect(actions.newAgent).not.toHaveBeenCalled();

    await act(async () => {
      finish();
      await first;
    });
    expect(result.current.disabled).toBe(false);
  });

  it('ignores actions while the plan is disabled', async () => {
    const actions = planActions();
    const { result } = renderHook(useGlyphPlanState, {
      initialProps: { state: viewState({ disabled: true }), actions },
    });

    await act(() => result.current.build());

    expect(result.current.disabled).toBe(true);
    expect(actions.build).not.toHaveBeenCalled();
  });

  it('reports failed actions until the next attempt', async () => {
    const actions = planActions();
    actions.build.mockRejectedValueOnce(new Error('Offline')).mockRejectedValueOnce('Refused');
    const { result } = renderHook(useGlyphPlanState, { initialProps: { state: viewState(), actions } });

    await act(() => result.current.build());
    expect(result.current.error).toBe('Offline');

    await act(() => result.current.build());
    expect(result.current.error).toBe('Refused');

    await act(() => result.current.build());
    expect(result.current.error).toBeUndefined();
  });
});
