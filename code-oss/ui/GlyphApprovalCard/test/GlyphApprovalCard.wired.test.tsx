import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphApprovalDecision } from '#src/desktop/protocol/GlyphApprovalDecision.js';
import { WiredGlyphApprovalCard } from '#code-oss/ui/GlyphApprovalCard/GlyphApprovalCard.wired.tsx';

afterEach(cleanup);

describe(WiredGlyphApprovalCard, () => {
  it.each([
    ['Keep unchanged', GlyphApprovalDecision.DENY],
    ['Apply change', GlyphApprovalDecision.ALLOW_ONCE],
  ] as const)('offers %s for the exact skill package comparison without reusable grants', (label, decision) => {
    const decideApproval = vi.fn(async () => {});
    render(
      <WiredGlyphApprovalCard
        request={{
          id: 'approval',
          title: 'Install example?',
          detail: 'Package proposal',
          sandboxed: false,
          skillChange: {
            id: 'preview',
            targetId: 'project',
            destination: {
              label: 'App project skills',
              scope: 'project' as const,
              path: '/project/.glyph/skills/review',
            },
            action: 'install',
            name: 'example',
            source: 'Agent proposal',
            revision: 'revision',
            createdParentDirectories: ['/project/.glyph'],
            directories: [
              { path: 'empty', status: 'added', afterMode: 0o750 },
              { path: 'old', status: 'removed', beforeMode: 0o700 },
            ],
            files: [
              { path: 'SKILL.md', status: 'added', after: 'Reviewed instructions' },
              { path: 'removed', status: 'removed', before: 'Old contents' },
              {
                path: 'image.bin',
                status: 'modified',
                beforeInfo: { encoding: 'binary', size: 3, digest: 'original-binary-sha', mode: 0o600 },
                afterInfo: { encoding: 'binary', size: 3, digest: 'reviewed-binary-sha', mode: 0o600 },
              },
            ],
          },
        }}
        chatId="chat"
        runId="run"
        actions={{ decideApproval }}
        disabled={false}
      />,
    );
    expect(screen.getByRole('region', { name: 'Skill change approval' }).textContent).toContain(
      'Reviewed instructions',
    );
    expect(screen.getByText('/project/.glyph/skills/review')).toBeDefined();
    expect(screen.getByText('Create installation directory /project/.glyph/')).toBeDefined();
    expect(screen.getByText('After · directory · mode 0750')).toBeDefined();
    expect(screen.getByText('Before · directory · mode 0700')).toBeDefined();
    expect(screen.getByText('reviewed-binary-sha')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Always Run' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(decideApproval).toHaveBeenCalledWith('chat', 'run', 'approval', decision);
  });
  it.each([
    ['Start goal', GlyphApprovalDecision.ALLOW_ONCE],
    ['Decline', GlyphApprovalDecision.DENY],
  ] as const)('offers an explicit %s decision for a proposed goal', (label, decision) => {
    const decideApproval = vi.fn(async () => {});
    render(
      <WiredGlyphApprovalCard
        request={{
          id: 'approval',
          title: 'Start a goal?',
          detail: 'Ship',
          sandboxed: false,
          goal: { objective: 'Ship' },
        }}
        chatId="chat"
        runId="run"
        actions={{ decideApproval }}
        disabled={false}
      />,
    );
    expect(screen.getByRole('region', { name: 'Goal approval' }).textContent).toContain('Ship');
    expect(screen.queryByRole('button', { name: 'Always Run' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(decideApproval).toHaveBeenCalledWith('chat', 'run', 'approval', decision);
  });
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

/** Policy metadata makes current denial/allowance explicit while both choices can enable future inspections. */
it.each([
  ['Allow & enable safe commands', GlyphApprovalDecision.ALLOW_SAFE],
  ['Deny & enable safe commands', GlyphApprovalDecision.DENY_AND_ALLOW_SAFE],
] as const)('submits only the advertised %s choice', (label, id) => {
  const decideApproval = vi.fn(() => new Promise<void>(() => {}));
  render(
    <WiredGlyphApprovalCard
      request={{
        id: 'approval',
        title: 'Shell',
        detail: 'echo changed',
        sandboxed: true,
        choices: [{ id, label, description: 'Future inspections run read-only.' }],
      }}
      chatId="chat"
      runId="run"
      actions={{ decideApproval }}
      disabled={false}
    />,
  );
  expect(screen.getByText('Future inspections run read-only.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Always Run' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: label }));
  expect(decideApproval).toHaveBeenCalledExactlyOnceWith('chat', 'run', 'approval', id);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: label }).disabled).toBe(true);
});
