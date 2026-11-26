import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { GlyphModeSwapStatus, type GlyphModeSwap } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import type { GlyphModeSwapCardProps } from '#code-oss/ui/GlyphModeSwapCard/GlyphModeSwapCard.presentational.tsx';
import { WiredGlyphModeSwapCard } from '#code-oss/ui/GlyphModeSwapCard/GlyphModeSwapCard.wired.tsx';

const rendered = vi.hoisted(() => ({ props: undefined as GlyphModeSwapCardProps | undefined }));

vi.mock('#code-oss/ui/GlyphModeSwapCard/GlyphModeSwapCard.presentational.tsx', async importOriginal => {
  const actual =
    await importOriginal<typeof import('#code-oss/ui/GlyphModeSwapCard/GlyphModeSwapCard.presentational.tsx')>();
  return {
    ...actual,
    GlyphModeSwapCard: (props: GlyphModeSwapCardProps) => {
      rendered.props = props;
      return <actual.GlyphModeSwapCard {...props} />;
    },
  };
});

afterEach(cleanup);

const useClock = () => {
  vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  onTestFinished(() => {
    vi.useRealTimers();
  });
};

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

describe(WiredGlyphModeSwapCard, () => {
  it('counts down to the deadline and then stops', () => {
    useClock();
    render(
      <WiredGlyphModeSwapCard
        swap={modeSwap()}
        chatId="chat"
        runId="run"
        actions={{ decideApproval: vi.fn(async () => {}) }}
        disabled={false}
      />,
    );
    const countdown = screen.getByRole('progressbar');
    expect(countdown.getAttribute('aria-valuetext')).toBe('10 seconds remaining');
    expect(countdown.getAttribute('aria-valuenow')).toBe('100');

    act(() => {
      vi.advanceTimersByTime(4500);
    });

    expect(countdown.getAttribute('aria-valuetext')).toBe('6 seconds remaining');
    expect(countdown.getAttribute('aria-valuenow')).toBe('55');

    act(() => {
      vi.advanceTimersByTime(7000);
    });

    expect(countdown.getAttribute('aria-valuetext')).toBe('0 seconds remaining');
    expect(countdown.getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled).toBe(true);
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(frames).not.toHaveBeenCalled();
  });

  it('stops counting down once it is removed', () => {
    useClock();
    const { unmount } = render(
      <WiredGlyphModeSwapCard
        swap={modeSwap()}
        chatId="chat"
        runId="run"
        actions={{ decideApproval: vi.fn(async () => {}) }}
        disabled={false}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    const frames = vi.spyOn(window, 'requestAnimationFrame');

    act(() => {
      unmount();
    });
    vi.advanceTimersByTime(100);

    expect(frames).not.toHaveBeenCalled();
  });

  it('does not count down a switch that has been decided', () => {
    useClock();
    render(
      <WiredGlyphModeSwapCard
        swap={modeSwap({ status: GlyphModeSwapStatus.APPROVED })}
        chatId="chat"
        runId="run"
        actions={{ decideApproval: vi.fn(async () => {}) }}
        disabled={false}
      />,
    );

    const frames = vi.spyOn(window, 'requestAnimationFrame');
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(frames).not.toHaveBeenCalled();
    expect(screen.getByRole('heading').textContent).toBe('Switched to Agent Mode');
  });

  it('shows an empty countdown for switches saved without a start time', () => {
    useClock();
    render(
      <WiredGlyphModeSwapCard
        swap={{
          id: 'swap',
          source: AgentModeID.PLAN,
          target: AgentModeID.AGENT,
          description: 'Ready to implement.',
          status: GlyphModeSwapStatus.PENDING,
          expiresAt: '2026-01-01T00:00:10.000Z',
          autoApprove: true,
        }}
        chatId="chat"
        runId="run"
        actions={{ decideApproval: vi.fn(async () => {}) }}
        disabled={false}
      />,
    );

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe('10 seconds remaining');
  });

  it('approves the switch once through the host', async () => {
    const decideApproval = vi.fn(() => new Promise<void>(() => {}));
    render(
      <WiredGlyphModeSwapCard
        swap={modeSwap({ expiresAt: '2999-01-01T00:00:00.000Z' })}
        chatId="chat"
        runId="run"
        actions={{ decideApproval }}
        disabled={false}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });

    expect(decideApproval).toHaveBeenCalledWith('chat', 'run', 'swap', GlyphApprovalDecision.ALLOW_ONCE);
    expect(screen.getByRole('region', { name: 'Mode switch' }).getAttribute('aria-busy')).toBe('true');
  });

  it('denies the switch through the host and shows failures', async () => {
    const decideApproval = vi.fn(async () => {
      throw new Error('Offline');
    });
    render(
      <WiredGlyphModeSwapCard
        swap={modeSwap({ expiresAt: '2999-01-01T00:00:00.000Z' })}
        chatId="chat"
        runId="run"
        actions={{ decideApproval }}
        disabled={false}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });

    expect(decideApproval).toHaveBeenCalledWith('chat', 'run', 'swap', GlyphApprovalDecision.DENY);
    expect(screen.getByRole('alert').textContent).toBe('Offline');
  });

  it('ignores decisions from a window that does not own the chat', async () => {
    const decideApproval = vi.fn(async () => {});
    render(
      <WiredGlyphModeSwapCard
        swap={modeSwap({ expiresAt: '2999-01-01T00:00:00.000Z' })}
        chatId="chat"
        runId="run"
        actions={{ decideApproval }}
        disabled
      />,
    );

    await act(async () => {
      rendered.props!.approve();
    });

    expect(decideApproval).not.toHaveBeenCalled();
  });

  it('ignores decisions about a switch that has been decided', async () => {
    const decideApproval = vi.fn(async () => {});
    render(
      <WiredGlyphModeSwapCard
        swap={modeSwap({ status: GlyphModeSwapStatus.DENIED })}
        chatId="chat"
        runId="run"
        actions={{ decideApproval }}
        disabled={false}
      />,
    );

    await act(async () => {
      rendered.props!.deny();
    });

    expect(decideApproval).not.toHaveBeenCalled();
  });
});
