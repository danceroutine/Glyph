import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlyphShellCommand } from '#src/desktop/protocol/events/GlyphShellCommand.js';
import { GlyphShellCommandCard } from '#code-oss/ui/GlyphShellCommandCard/GlyphShellCommandCard.presentational.tsx';
import type { GlyphShellCommandCardState } from '#code-oss/ui/GlyphShellCommandCard/useGlyphShellCommandCardState.ts';

afterEach(cleanup);

const cardState = (
  shell: Partial<GlyphShellCommand> = {},
  overrides: Partial<GlyphShellCommandCardState> = {},
): GlyphShellCommandCardState => ({
  shell: {
    command: 'npm test',
    output: 'one\ntwo\nthree',
    sessionId: 'session',
    background: false,
    live: true,
    running: true,
    ...shell,
  },
  expanded: false,
  input: '',
  appendNewline: true,
  pending: false,
  error: undefined,
  status: 'Running',
  failed: false,
  preview: 'two\nthree',
  disabled: false,
  canSend: true,
  toggle: vi.fn(),
  changeInput: vi.fn(),
  changeAppendNewline: vi.fn(),
  sendInput: vi.fn(),
  close: vi.fn(),
  ...overrides,
});

describe(GlyphShellCommandCard, () => {
  it('summarizes a collapsed command with its status and output preview', () => {
    const state = cardState();
    render(<GlyphShellCommandCard {...state} />);

    const card = screen.getByRole('region', { name: 'Shell command' });
    expect(card.dataset.live).toBe('true');
    expect(card.getAttribute('aria-busy')).toBe('false');
    const header = screen.getByRole('button', { name: /npm test/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.querySelector('.lucide-chevron-right')).toBeTruthy();
    expect(header.textContent).toBe('npm testRunning');
    expect(screen.getByLabelText('Command output').textContent).toBe('two\nthree');
    expect(screen.queryByText('$ npm test')).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByText(/Wake on/)).toBeNull();

    fireEvent.click(header);

    expect(state.toggle).toHaveBeenCalledOnce();
  });

  it('highlights a failed status', () => {
    render(<GlyphShellCommandCard {...cardState({}, { failed: true, status: 'Failed' })} />);
    const ok = screen.getByText('Failed').className;
    cleanup();
    render(<GlyphShellCommandCard {...cardState({}, { status: 'Failed' })} />);

    expect(screen.getByText('Failed').className).not.toBe(ok);
  });

  it('shows the wake pattern and shell errors', () => {
    render(<GlyphShellCommandCard {...cardState({ wakePattern: 'ready', error: 'spawn failed' })} />);

    expect(screen.getByText('ready').tagName).toBe('CODE');
    expect(screen.getByText('spawn failed')).toBeTruthy();
  });

  it('shows the full command, output and working directory when expanded', () => {
    render(
      <GlyphShellCommandCard
        {...cardState({ workingDirectory: '/repo', live: false, running: false }, { expanded: true })}
      />,
    );

    expect(screen.getByRole('button', { name: /npm test/ }).querySelector('.lucide-chevron-down')).toBeTruthy();
    expect(screen.getByText('$ npm test')).toBeTruthy();
    expect(screen.getByLabelText('Command output').textContent).toBe('one\ntwo\nthree');
    expect(screen.getByText('Working directory: /repo')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close shell' })).toBeNull();
  });

  it('omits the working directory when it is unknown', () => {
    render(<GlyphShellCommandCard {...cardState({}, { expanded: true })} />);

    expect(screen.queryByText(/Working directory/)).toBeNull();
  });

  it('accepts input for a running live shell', () => {
    const state = cardState({}, { expanded: true, input: 'yes' });
    render(<GlyphShellCommandCard {...state} />);
    const input = screen.getByRole('textbox', { name: 'Input to shell' }) as HTMLTextAreaElement;
    const newline = screen.getByRole('checkbox', { name: 'Append newline' }) as HTMLInputElement;
    expect(input.value).toBe('yes');
    expect(newline.checked).toBe(true);

    fireEvent.input(input, { target: { value: 'no' } });
    fireEvent.click(newline);
    fireEvent.click(screen.getByRole('button', { name: 'Send input' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close shell' }));

    expect(state.changeInput).toHaveBeenCalledWith('no');
    expect(state.changeAppendNewline).toHaveBeenCalledWith(false);
    expect(state.sendInput).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
  });

  it('only offers closing an idle live shell', () => {
    render(<GlyphShellCommandCard {...cardState({ running: false }, { expanded: true })} />);

    expect(screen.queryByRole('form', { name: 'Shell input' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close shell' })).toBeTruthy();
  });

  it('disables shell controls while unavailable', () => {
    render(
      <GlyphShellCommandCard {...cardState({}, { expanded: true, pending: true, disabled: true, canSend: false })} />,
    );

    expect(screen.getByRole('region', { name: 'Shell command' }).getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'Input to shell' }) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox', { name: 'Append newline' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Send input' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Close shell' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows why the last shell action failed', () => {
    render(<GlyphShellCommandCard {...cardState({}, { error: 'Gone' })} />);

    expect(screen.getByRole('alert').textContent).toBe('Gone');
  });
});
