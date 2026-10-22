import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { GlyphPlan } from '#src/desktop/protocol/events/GlyphPlan.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import { aGlyphPlan } from '#src/desktop/tests/fixtures/aGlyphPlan.ts';
import { useGlyphPlanCardsState } from '#code-oss/ui/GlyphPlan/useGlyphPlanCardsState.ts';

const plan = (overrides: Partial<GlyphPlan> = {}) => aGlyphPlan({ title: 'Ship it', summary: 'Summary', ...overrides });

const cardActions = () => ({
  viewPlan: vi.fn(async (_chatId: string, _plan: GlyphPlan) => {}),
  buildPlan: vi.fn(async (_chatId: string, _plan: GlyphPlan, _newChat?: boolean) => {}),
});

describe(useGlyphPlanCardsState, () => {
  it('shows the latest revision of each plan once', () => {
    const latest = plan({ id: 'a', revision: 2 });
    const { result } = renderHook(useGlyphPlanCardsState, {
      initialProps: {
        chatId: 'chat',
        plans: [plan({ id: 'a', revision: 1 }), plan({ id: 'b' }), latest],
        actions: cardActions() as unknown as GlyphWorkbenchViewActions,
      },
    });

    expect(result.current.plans.map(value => [value.id, value.revision])).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    expect(result.current.plans[0]).toBe(latest);
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeUndefined();
  });

  it('views and builds plans through the host', async () => {
    const actions = cardActions();
    const target = plan();
    const { result } = renderHook(useGlyphPlanCardsState, {
      initialProps: { chatId: 'chat', plans: [target], actions: actions as unknown as GlyphWorkbenchViewActions },
    });

    await act(() => result.current.view(target));
    await act(() => result.current.build(target));
    await act(() => result.current.build(target, true));

    expect(actions.viewPlan).toHaveBeenCalledWith('chat', target);
    expect(actions.buildPlan.mock.calls).toEqual([
      ['chat', target, false],
      ['chat', target, true],
    ]);
  });

  it('does nothing when the host cannot view or build plans', async () => {
    const target = plan();
    const { result } = renderHook(useGlyphPlanCardsState, {
      initialProps: { chatId: 'chat', plans: [target], actions: {} as GlyphWorkbenchViewActions },
    });

    await act(() => result.current.view(target));
    await act(() => result.current.build(target));

    expect(result.current.error).toBeUndefined();
    expect(result.current.pending).toBe(false);
  });

  it('runs one action at a time and is pending until it settles', async () => {
    const actions = cardActions();
    let finish!: () => void;
    actions.buildPlan.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );
    const target = plan();
    const { result } = renderHook(useGlyphPlanCardsState, {
      initialProps: { chatId: 'chat', plans: [target], actions: actions as unknown as GlyphWorkbenchViewActions },
    });

    let first!: Promise<void>;
    act(() => {
      first = result.current.build(target);
    });
    expect(result.current.pending).toBe(true);

    await act(() => result.current.view(target));
    expect(actions.viewPlan).not.toHaveBeenCalled();

    await act(async () => {
      finish();
      await first;
    });
    expect(result.current.pending).toBe(false);
  });

  it('reports failed actions until the next attempt', async () => {
    const actions = cardActions();
    actions.viewPlan.mockRejectedValueOnce(new Error('Missing')).mockRejectedValueOnce('Refused');
    const target = plan();
    const { result } = renderHook(useGlyphPlanCardsState, {
      initialProps: { chatId: 'chat', plans: [target], actions: actions as unknown as GlyphWorkbenchViewActions },
    });

    await act(() => result.current.view(target));
    expect(result.current.error).toBe('Missing');

    await act(() => result.current.view(target));
    expect(result.current.error).toBe('Refused');

    await act(() => result.current.view(target));
    expect(result.current.error).toBeUndefined();
  });
});
