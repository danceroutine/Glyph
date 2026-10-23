import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import { WiredGlyphApprovalCard } from '#code-oss/ui/GlyphApprovalCard/GlyphApprovalCard.wired.tsx';

afterEach(cleanup);

describe(WiredGlyphApprovalCard, () => {
  it('describes the command awaiting approval', () => {
    render(
      <WiredGlyphApprovalCard
        request={{
          id: 'approval-1',
          title: 'Run tests',
          detail: 'Runs the test suite',
          sandboxed: false,
          command: 'pnpm test',
          workingDirectory: '/repo',
          canRemember: true,
        }}
        chatId="chat-1"
        runId="run-1"
        actions={{ decideApproval: vi.fn(async () => {}) }}
        disabled={false}
      />,
    );

    const card = screen.getByRole('region', { name: 'Command approval' });
    expect(screen.getByRole('heading', { name: 'Run tests' })).toBeTruthy();
    expect(card.querySelector('pre')!.textContent).toBe('pnpm test');
    expect(screen.getByText('Working directory: /repo')).toBeTruthy();
    expect(screen.getByText('Always Run remembers this exact command in this directory.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Always Run' })).toBeTruthy();
    expect(card.getAttribute('aria-busy')).toBe('false');
  });

  it('falls back to the request detail and hides optional choices', () => {
    render(
      <WiredGlyphApprovalCard
        request={{ id: 'approval-1', title: 'Network access', detail: 'Fetch example.com', sandboxed: true }}
        chatId="chat-1"
        runId="run-1"
        actions={{ decideApproval: vi.fn(async () => {}) }}
        disabled={false}
      />,
    );

    expect(screen.getByRole('region').querySelector('pre')!.textContent).toBe('Fetch example.com');
    expect(screen.queryByText(/Working directory/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Always Run' })).toBeNull();
    expect(screen.queryByText('Approve in the window that owns this chat.')).toBeNull();
  });

  it('submits the chosen decision and waits for the result', () => {
    const decideApproval = vi.fn(() => new Promise<void>(() => {}));
    render(
      <WiredGlyphApprovalCard
        request={{ id: 'approval-1', title: 'Run', detail: 'ls', sandboxed: true, canRemember: true }}
        chatId="chat-1"
        runId="run-1"
        actions={{ decideApproval }}
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(decideApproval).toHaveBeenCalledWith('chat-1', 'run-1', 'approval-1', GlyphApprovalDecision.ALLOW_ONCE);
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeTruthy();
    expect(screen.getByRole('region').getAttribute('aria-busy')).toBe('true');
    for (const name of ['Skip', 'Always Run', 'Submitting…']) {
      expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
    }
  });

  it('shows failures beneath the choices', async () => {
    render(
      <WiredGlyphApprovalCard
        request={{ id: 'approval-1', title: 'Run', detail: 'ls', sandboxed: true }}
        chatId="chat-1"
        runId="run-1"
        actions={{ decideApproval: vi.fn().mockRejectedValue('Gone') }}
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('Gone');
    });
  });

  it('defers to the window that owns the chat', () => {
    render(
      <WiredGlyphApprovalCard
        request={{ id: 'approval-1', title: 'Run', detail: 'ls', sandboxed: true, canRemember: true }}
        chatId="chat-1"
        runId="run-1"
        actions={{ decideApproval: vi.fn(async () => {}) }}
        disabled
      />,
    );

    expect(screen.getByText('Approve in the window that owns this chat.')).toBeTruthy();
    for (const name of ['Skip', 'Always Run', 'Run']) {
      expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
    }
  });
});
