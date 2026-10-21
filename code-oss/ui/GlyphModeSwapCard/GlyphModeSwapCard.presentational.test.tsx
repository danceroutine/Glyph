import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { GlyphModeSwapStatus, type GlyphModeSwap } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphModeSwapCard } from '#code-oss/ui/GlyphModeSwapCard/GlyphModeSwapCard.presentational.tsx';
import { AGENT_MODE_PRESENTATION } from '#code-oss/ui/AgentMode/AgentModePresentation.tsx';

afterEach(cleanup);

const modeSwap = (overrides: Partial<GlyphModeSwap> = {}): GlyphModeSwap => ({
  id: 'swap',
  source: AgentModeID.PLAN,
  target: AgentModeID.AGENT,
  description: 'Ready to implement.',
  status: GlyphModeSwapStatus.PENDING,
  startedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:00:10.000Z',
  autoApprove: true,
  ...overrides,
});

describe(GlyphModeSwapCard, () => {
  it('asks to switch modes with an automatic approval countdown', () => {
    const approve = vi.fn();
    const deny = vi.fn();
    render(<GlyphModeSwapCard swap={modeSwap()} seconds={7} remaining={0.654} approve={approve} deny={deny} />);

    const card = screen.getByRole('region', { name: 'Mode switch' });
    expect(card.getAttribute('aria-busy')).toBe('false');
    expect(screen.getByRole('heading').textContent).toBe('Switch to Agent Mode');
    expect(screen.getByText('Ready to implement.')).toBeTruthy();
    const countdown = screen.getByRole('progressbar', { name: 'Automatic approval countdown' });
    expect(countdown.getAttribute('aria-valuenow')).toBe('65');
    expect(countdown.getAttribute('aria-valuetext')).toBe('7 seconds remaining');
    const bar = countdown.firstElementChild as HTMLElement;
    expect(bar.style.transform).toBe('scaleX(0.654)');
    expect(bar.style.background).toBe(AGENT_MODE_PRESENTATION[AgentModeID.PLAN].accent);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Respond in the window that owns this chat.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

    expect(approve).toHaveBeenCalledOnce();
    expect(deny).toHaveBeenCalledOnce();
  });

  it('counts down to an automatic denial', () => {
    render(
      <GlyphModeSwapCard
        swap={modeSwap({ autoApprove: false })}
        seconds={3}
        remaining={0.3}
        approve={vi.fn()}
        deny={vi.fn()}
      />,
    );

    expect(screen.getByRole('progressbar', { name: 'Automatic denial countdown' })).toBeTruthy();
  });

  it('reports a switch that was approved without offering a decision', () => {
    render(
      <GlyphModeSwapCard
        swap={modeSwap({ status: GlyphModeSwapStatus.APPROVED })}
        seconds={0}
        remaining={0}
        pending
        approve={vi.fn()}
        deny={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading').textContent).toBe('Switched to Agent Mode');
    expect(screen.getByRole('region', { name: 'Mode switch' }).getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it.each([GlyphModeSwapStatus.DENIED, GlyphModeSwapStatus.CANCELLED, GlyphModeSwapStatus.FAILED])(
    'reports a switch that was %s',
    status => {
      render(
        <GlyphModeSwapCard swap={modeSwap({ status })} seconds={0} remaining={0} approve={vi.fn()} deny={vi.fn()} />,
      );

      expect(screen.getByRole('heading').textContent).toBe(`Switch to Agent Mode ${status}`);
    },
  );

  it('becomes busy and unavailable while a decision is pending', () => {
    render(
      <GlyphModeSwapCard swap={modeSwap()} seconds={5} remaining={0.5} pending approve={vi.fn()} deny={vi.fn()} />,
    );

    expect(screen.getByRole('region', { name: 'Mode switch' }).getAttribute('aria-busy')).toBe('true');
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('cannot be decided once its countdown has run out', () => {
    render(<GlyphModeSwapCard swap={modeSwap()} seconds={0} remaining={0} approve={vi.fn()} deny={vi.fn()} />);

    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('directs the decision to the window that owns the chat', () => {
    render(
      <GlyphModeSwapCard swap={modeSwap()} seconds={5} remaining={0.5} disabled approve={vi.fn()} deny={vi.fn()} />,
    );

    expect(screen.getByText('Respond in the window that owns this chat.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows why the last decision failed', () => {
    render(
      <GlyphModeSwapCard
        swap={modeSwap()}
        seconds={5}
        remaining={0.5}
        error="Offline"
        approve={vi.fn()}
        deny={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert').textContent).toBe('Offline');
  });
});
