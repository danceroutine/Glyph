import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { AgentMode, AgentModeID } from '#src/chat/AgentMode.js';
import { useGlyphModePickerState } from '#code-oss/ui/GlyphModePicker/useGlyphModePickerState.ts';

describe(useGlyphModePickerState, () => {
  it('exposes every agent mode with the current mode selected', () => {
    const change = vi.fn();

    const { result } = renderHook(useGlyphModePickerState, {
      initialProps: { mode: AgentModeID.PLAN, change },
    });

    expect(result.current.mode).toBe(AgentModeID.PLAN);
    expect(result.current.modes).toBe(AgentMode.all);
    expect(result.current.selectedIndex).toBe(AgentMode.all.findIndex(mode => mode.id === AgentModeID.PLAN));
  });

  it('reports the chosen mode through the change callback', () => {
    const change = vi.fn();
    const { result } = renderHook(useGlyphModePickerState, {
      initialProps: { mode: AgentModeID.PLAN, change },
    });
    const agent = AgentMode.all.find(mode => mode.id === AgentModeID.AGENT)!;

    act(() => {
      result.current.select(agent);
    });

    expect(change).toHaveBeenCalledWith(AgentModeID.AGENT);
  });

  it('finds modes by their display names when typing ahead', () => {
    const change = vi.fn();
    const { result } = renderHook(useGlyphModePickerState, {
      initialProps: { mode: AgentModeID.AGENT, change },
    });

    act(() => {
      result.current.keydown(new KeyboardEvent('keydown', { key: 'p' }));
    });

    expect(result.current.open).toBe(true);
    expect(result.current.activeIndex).toBe(AgentMode.all.findIndex(mode => mode.id === AgentModeID.PLAN));
  });
});
