import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlyphBackgroundShell } from '#src/desktop/protocol/events/GlyphBackgroundShell.js';
import { GlyphBackgroundTerminals } from '#code-oss/ui/GlyphBackgroundTerminals/GlyphBackgroundTerminals.tsx';

afterEach(cleanup);

function shell(id: string, command: string, overrides: Partial<GlyphBackgroundShell> = {}): GlyphBackgroundShell {
  return { id, chatId: 'chat-1', command, workingDirectory: '/repo', output: '', running: true, ...overrides };
}

describe(GlyphBackgroundTerminals, () => {
  it('renders nothing without running terminals', () => {
    const { container } = render(
      <GlyphBackgroundTerminals
        shells={[shell('s1', 'done', { running: false })]}
        open={vi.fn(async () => {})}
        stop={vi.fn(async () => {})}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('counts running terminals in a collapsed drawer', () => {
    render(
      <GlyphBackgroundTerminals
        shells={[shell('s1', 'pnpm dev', { wakePattern: 'ready' }), shell('s2', 'done', { running: false })]}
        open={vi.fn(async () => {})}
        stop={vi.fn(async () => {})}
      />,
    );

    const header = screen.getByRole('button', { name: '1 background terminal' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    const list = document.querySelector(`[id="${header.getAttribute('aria-controls')!}"]`)!;
    const reveal = list.parentElement!.parentElement!;
    expect(reveal.inert).toBe(true);
    expect(reveal.getAttribute('aria-hidden')).toBe('true');

    fireEvent.click(header);

    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(reveal.inert).toBe(false);
    expect(Object.hasOwn(reveal.dataset, 'expanded')).toBe(true);
    expect(screen.getByRole('listitem').textContent).toContain('Wake on: ready');
  });

  it('pluralizes several terminals', () => {
    render(
      <GlyphBackgroundTerminals
        shells={[shell('s1', 'pnpm dev'), shell('s2', 'tail -f log')]}
        open={vi.fn(async () => {})}
        stop={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByRole('button', { name: '2 background terminals' })).toBeTruthy();
    expect(screen.getAllByRole('listitem', { hidden: true }).every(item => !item.textContent.includes('Wake on'))).toBe(
      true,
    );
  });

  it('opens and stops terminals one action at a time', async () => {
    let finishOpen!: () => void;
    const open = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishOpen = resolve;
        }),
    );
    const stop = vi.fn(async () => {});
    const target = shell('s1', 'pnpm dev');
    render(<GlyphBackgroundTerminals shells={[target]} open={open} stop={stop} />);
    fireEvent.click(screen.getByRole('button', { name: '1 background terminal' }));
    const openButton = screen.getByRole<HTMLButtonElement>('button', { name: 'pnpm dev' });
    const stopButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Stop' });
    expect(openButton.title).toBe('Open terminal: pnpm dev');

    act(() => {
      openButton.click();
      stopButton.click();
    });
    expect(open).toHaveBeenCalledExactlyOnceWith(target);
    expect(stop).not.toHaveBeenCalled();
    expect(openButton.disabled).toBe(true);
    expect(stopButton.disabled).toBe(true);
    await act(async () => {
      finishOpen();
    });
    expect(openButton.disabled).toBe(false);
    fireEvent.click(stopButton);

    await waitFor(() => {
      expect(stop).toHaveBeenCalledExactlyOnceWith(target);
    });
  });

  it('shows why an action failed until the next attempt', async () => {
    const open = vi.fn().mockRejectedValueOnce(new Error('Terminal closed')).mockResolvedValueOnce(undefined);
    const stop = vi.fn().mockRejectedValueOnce('Permission denied');
    render(<GlyphBackgroundTerminals shells={[shell('s1', 'pnpm dev')]} open={open} stop={stop} />);
    fireEvent.click(screen.getByRole('button', { name: '1 background terminal' }));

    fireEvent.click(screen.getByRole('button', { name: 'pnpm dev' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Terminal closed');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Permission denied');
    });
    fireEvent.click(screen.getByRole('button', { name: 'pnpm dev' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('disables terminal actions when requested', () => {
    render(
      <GlyphBackgroundTerminals
        shells={[shell('s1', 'pnpm dev')]}
        disabled
        open={vi.fn(async () => {})}
        stop={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'pnpm dev', hidden: true }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Stop', hidden: true }).disabled).toBe(true);
  });
});
