import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMode, AgentModeID } from '#src/chat/AgentMode.js';
import { GlyphModePicker } from '#code-oss/ui/GlyphModePicker/GlyphModePicker.presentational.tsx';
import type { GlyphModePickerState } from '#code-oss/ui/GlyphModePicker/useGlyphModePickerState.ts';

afterEach(cleanup);

const pickerState = (overrides: Partial<GlyphModePickerState> = {}): GlyphModePickerState => ({
  root: createRef<HTMLDivElement>(),
  trigger: createRef<HTMLButtonElement>(),
  id: 'modes',
  open: false,
  activeIndex: 0,
  highlight: vi.fn(),
  select: vi.fn(),
  toggle: vi.fn(),
  blur: vi.fn(),
  keydown: vi.fn(),
  mode: AgentModeID.AGENT,
  modes: AgentMode.all,
  selectedIndex: 0,
  ...overrides,
});

describe(GlyphModePicker, () => {
  it('shows the current mode on a collapsed combobox', () => {
    render(<GlyphModePicker {...pickerState({ mode: AgentModeID.PLAN, selectedIndex: 1 })} />);

    const trigger = screen.getByRole('combobox', { name: 'Conversation mode' });
    expect(trigger.textContent).toBe('Plan');
    expect(trigger.dataset.mode).toBe(AgentModeID.PLAN);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    expect(trigger.hasAttribute('aria-activedescendant')).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('lists every mode with the active and selected options marked', () => {
    render(<GlyphModePicker {...pickerState({ open: true, activeIndex: 1, selectedIndex: 0 })} />);

    const trigger = screen.getByRole('combobox', { name: 'Conversation mode' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe('modes');
    expect(trigger.getAttribute('aria-activedescendant')).toBe('modes-1');
    expect(screen.getByRole('listbox', { name: 'Conversation modes' }).id).toBe('modes');
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Agent', 'Plan']);
    expect(screen.getByRole('option', { name: 'Agent' }).getAttribute('aria-selected')).toBe('true');
  });

  it('forwards interaction to its state', () => {
    const state = pickerState({ open: true });
    render(
      <>
        <GlyphModePicker {...state} />
        <button type="button">Elsewhere</button>
      </>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Conversation mode' });

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'Plan' }));
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    fireEvent.blur(state.root.current!, { relatedTarget: elsewhere });

    expect(state.toggle).toHaveBeenCalled();
    expect(state.keydown).toHaveBeenCalledWith(expect.objectContaining({ key: 'ArrowDown' }));
    expect(state.select).toHaveBeenCalledWith(AgentMode.resolve(AgentModeID.PLAN));
    expect(state.blur).toHaveBeenCalledWith(elsewhere);
    expect(state.root.current).toBeInstanceOf(HTMLDivElement);
    expect(state.trigger.current).toBe(trigger);
  });
});
