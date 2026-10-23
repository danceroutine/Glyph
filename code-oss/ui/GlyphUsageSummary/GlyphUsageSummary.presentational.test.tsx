import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphUsageSummary } from '#code-oss/ui/GlyphUsageSummary/GlyphUsageSummary.presentational.tsx';

afterEach(cleanup);

const usageState = (open: boolean) => ({
  id: 'usage-popup',
  trigger: createRef<HTMLButtonElement>(),
  popup: createRef<HTMLDivElement>(),
  open,
  position: { left: 12, top: 34 },
  toggle: vi.fn(),
});

describe(GlyphUsageSummary, () => {
  it('offers conversation usage from a labeled button', () => {
    const state = usageState(false);
    render(<GlyphUsageSummary usage={undefined} {...state} />);

    const trigger = screen.getByRole('button', { name: 'Conversation token usage' });
    expect(trigger.textContent).toBe('Usage');
    expect(trigger.getAttribute('title')).toBe('Conversation token usage');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    expect(state.trigger.current).toBe(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(trigger);

    expect(state.toggle).toHaveBeenCalledOnce();
  });

  it('offers turn usage from an icon button', () => {
    render(<GlyphUsageSummary usage={undefined} turn {...usageState(false)} />);

    const trigger = screen.getByRole('button', { name: 'Turn token usage' });
    expect(trigger.textContent).toBe('');
    expect(trigger.querySelector('svg')).toBeTruthy();
  });

  it('breaks down reported conversation usage', () => {
    const state = usageState(true);
    render(
      <GlyphUsageSummary
        usage={{
          inputTokens: 12000,
          cachedInputTokens: 3000,
          outputTokens: 450,
          reasoningTokens: 200,
          totalTokens: 12450,
        }}
        {...state}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Conversation token usage' });
    expect(screen.getByRole('button', { name: 'Conversation token usage' }).getAttribute('aria-controls')).toBe(
      'usage-popup',
    );
    expect(dialog.id).toBe('usage-popup');
    expect(dialog.parentElement).toBe(document.body);
    expect(state.popup.current).toBe(dialog);
    expect([dialog.style.left, dialog.style.top]).toEqual(['12px', '34px']);
    expect(dialog.querySelector('strong')?.textContent).toBe('Conversation usage');
    expect([...dialog.querySelectorAll('dt')].map(term => term.textContent)).toEqual([
      'Input',
      'Cached input',
      'Output',
      'Reasoning',
      'Total',
    ]);
    expect([...dialog.querySelectorAll('dd')].map(value => value.textContent)).toEqual(
      [12000, 3000, 450, 200, 12450].map(value => value.toLocaleString()),
    );
    expect(dialog.textContent).toContain('Reported usage for completed turns. Interrupted turns are excluded.');
    expect(dialog.textContent).toContain('Cached input is included in input; reasoning is included in output.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('explains when turn usage is unavailable', () => {
    render(<GlyphUsageSummary usage={undefined} turn {...usageState(true)} />);

    const dialog = screen.getByRole('dialog', { name: 'Turn token usage' });
    expect(dialog.querySelector('strong')?.textContent).toBe('Turn usage');
    expect(dialog.textContent).toContain('Token usage unavailable.');
    expect(dialog.textContent).toContain('Reported usage for this turn.');
    expect(dialog.textContent).not.toContain('Cached input is included');
    expect(dialog.querySelector('dl')).toBeNull();
  });

  it.each([
    [1, 'Usage missing or incomplete for 1 completed turn.'],
    [3, 'Usage missing or incomplete for 3 completed turns.'],
  ])('warns about %i turns without complete usage', (unreportedTurns, message) => {
    render(
      <GlyphUsageSummary
        usage={{
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
          reasoningTokens: 0,
          totalTokens: 2,
          unreportedTurns,
        }}
        {...usageState(true)}
      />,
    );

    expect(screen.getByRole('status').textContent).toBe(message);
  });

  it('opens within the workbench when there is one', () => {
    const workbench = document.createElement('div');
    workbench.className = 'monaco-workbench';
    document.body.append(workbench);
    onTestFinished(() => {
      workbench.remove();
    });

    render(<GlyphUsageSummary usage={undefined} {...usageState(true)} />);

    expect(screen.getByRole('dialog').parentElement).toBe(workbench);
  });

  it('opens within the surrounding story stage outside of the workbench', () => {
    const stage = document.createElement('div');
    stage.className = 'glyph-story-stage';
    document.body.append(stage);
    onTestFinished(() => {
      stage.remove();
    });
    const state = usageState(false);
    const { rerender } = render(<GlyphUsageSummary usage={undefined} {...state} />, { container: stage });

    rerender(<GlyphUsageSummary usage={undefined} {...state} open />);

    expect(screen.getByRole('dialog').parentElement).toBe(stage);
  });
});
