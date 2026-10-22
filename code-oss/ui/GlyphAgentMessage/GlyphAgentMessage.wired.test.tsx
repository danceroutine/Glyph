import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModeID } from '#src/chat/AgentMode.js';
import { GlyphModeSwapStatus } from '#src/desktop/protocol/events/GlyphModeSwap.js';
import { GlyphRunStatus, type GlyphRunProjection } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { aGlyphRunProjection } from '#src/desktop/tests/fixtures/aGlyphRunProjection.ts';
import {
  GlyphAgentMessageWithState,
  WiredGlyphAgentMessage,
  type GlyphMessageActions,
} from '#code-oss/ui/GlyphAgentMessage/GlyphAgentMessage.wired.tsx';
import { useGlyphMessageState } from '#code-oss/ui/GlyphAgentMessage/useGlyphMessageState.ts';

afterEach(cleanup);

function transcriptEntry(overrides: Partial<GlyphTranscriptEntry> = {}): GlyphTranscriptEntry {
  return { id: 'run-1', role: GlyphTranscriptRole.ASSISTANT, text: 'All done.', ...overrides };
}

function messageActions(overrides: Partial<GlyphMessageActions> = {}): GlyphMessageActions {
  return {
    decideApproval: vi.fn(async () => {}),
    writeShellInput: vi.fn(async () => {}),
    stopShell: vi.fn(async () => {}),
    copyText: vi.fn(async () => {}),
    ...overrides,
  };
}

function pendingRun(overrides: Partial<GlyphRunProjection> = {}): GlyphRunProjection {
  return aGlyphRunProjection({
    chatId: 'chat-1',
    runId: 'run-1',
    status: GlyphRunStatus.WAITING_FOR_APPROVAL,
    approval: { id: 'approval-1', title: 'Run tests', detail: 'pnpm test', sandboxed: true },
    ...overrides,
  });
}

describe(WiredGlyphAgentMessage, () => {
  it('renders the answer with message actions', () => {
    const actions = messageActions();
    render(<WiredGlyphAgentMessage entry={transcriptEntry({ createdAt: '2026-10-20T12:00:00Z' })} actions={actions} />);

    expect(screen.getByText('All done.')).toBeTruthy();
    const source = document.querySelector<HTMLElement>('[data-glyph-source="run-1"]')!;
    expect(source.dataset.kind).toBe('chat');
    expect(source.dataset.label).toBe('Glyph');
    expect(source.dataset.revision).toBe('9');
    expect(screen.getByRole('contentinfo', { name: 'Message actions' })).toBeTruthy();
    expect(document.querySelector('time')!.getAttribute('datetime')).toBe('2026-10-20T12:00:00Z');
    expect(screen.queryByRole('button', { name: 'Branch chat' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));

    expect(actions.copyText).toHaveBeenCalledWith('All done.');
  });

  it('branches the conversation from a checkpoint', async () => {
    const branchChat = vi.fn(async () => {});
    render(
      <WiredGlyphAgentMessage
        entry={transcriptEntry({ checkpointTurnId: 'turn-1' })}
        chatId="chat-1"
        actions={messageActions({ branchChat })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Branch chat' }));

    expect(branchChat).toHaveBeenCalledWith('chat-1', 'turn-1');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Branch chat' }).disabled).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Branch chat' }).disabled).toBe(false);
    });
  });

  it('cannot branch read-only, unsaved or hostless conversations', () => {
    const entry = transcriptEntry({ checkpointTurnId: 'turn-1' });
    const branchChat = vi.fn(async () => {});
    const { rerender } = render(
      <WiredGlyphAgentMessage entry={entry} chatId="chat-1" readOnly actions={messageActions({ branchChat })} />,
    );
    expect(screen.queryByRole('button', { name: 'Branch chat' })).toBeNull();

    rerender(<WiredGlyphAgentMessage entry={entry} actions={messageActions({ branchChat })} />);
    expect(screen.queryByRole('button', { name: 'Branch chat' })).toBeNull();

    rerender(<WiredGlyphAgentMessage entry={entry} chatId="chat-1" actions={messageActions()} />);
    expect(screen.queryByRole('button', { name: 'Branch chat' })).toBeNull();

    rerender(<WiredGlyphAgentMessage entry={entry} chatId="chat-1" />);
    expect(screen.queryByRole('button', { name: 'Branch chat' })).toBeNull();
  });

  it('shows answers, progress, annotations and live cards that belong to the message', () => {
    render(
      <WiredGlyphAgentMessage
        entry={transcriptEntry({
          questionResponses: [{ id: 'q1', answers: [{ question: 'Which?', answer: 'This one' }] }],
          progress: {
            status: GlyphRunStatus.STREAMING,
            reasoning: '',
            tools: [
              { id: 't1', name: 'read_file', status: GlyphToolActivityStatus.COMPLETED },
              {
                id: 't2',
                name: 'shell',
                status: GlyphToolActivityStatus.STARTED,
                shell: { command: 'pnpm build', output: '', background: false, live: true, running: true },
              },
            ],
          },
          modeSwaps: [
            {
              id: 'swap-1',
              source: AgentModeID.PLAN,
              target: AgentModeID.AGENT,
              description: 'Switch to build',
              status: GlyphModeSwapStatus.APPROVED,
              expiresAt: '2026-10-20T12:00:00Z',
              autoApprove: false,
            },
          ],
          options: {
            annotations: [
              {
                id: 'n1',
                order: 1,
                kind: 'chat',
                sourceId: 's',
                revision: '1',
                label: 'Chat',
                quote: 'q',
                from: 0,
                to: 1,
                comment: 'c',
              },
            ],
          },
        })}
        chatId="chat-1"
        pendingApproval={pendingRun()}
        actions={messageActions()}
      />,
    );

    expect(screen.getByRole('region', { name: 'Submitted answers' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Turn progress' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Shell command' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Mode switch' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Command approval' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 annotation' })).toBeTruthy();
  });

  it('leaves live cards out without a host to act on them', () => {
    render(
      <WiredGlyphAgentMessage
        entry={transcriptEntry({
          progress: {
            status: GlyphRunStatus.STREAMING,
            reasoning: '',
            tools: [
              {
                id: 't2',
                name: 'shell',
                status: GlyphToolActivityStatus.STARTED,
                shell: { command: 'pnpm build', output: '', background: false, live: true, running: true },
              },
            ],
          },
        })}
        pendingApproval={pendingRun()}
      />,
    );

    expect(screen.queryByRole('region', { name: 'Shell command' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Command approval' })).toBeNull();
  });

  it('shows approvals only for its own run and not for mode switches', () => {
    const { rerender } = render(
      <WiredGlyphAgentMessage
        entry={transcriptEntry()}
        chatId="chat-1"
        pendingApproval={pendingRun({ runId: 'run-2' })}
        actions={messageActions()}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Command approval' })).toBeNull();

    rerender(
      <WiredGlyphAgentMessage
        entry={transcriptEntry()}
        chatId="chat-1"
        pendingApproval={{
          chatId: 'chat-1',
          runId: 'run-1',
          status: GlyphRunStatus.STREAMING,
          text: '',
          reasoning: '',
          tools: [],
        }}
        actions={messageActions()}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Command approval' })).toBeNull();

    rerender(
      <WiredGlyphAgentMessage
        entry={transcriptEntry()}
        chatId="chat-1"
        pendingApproval={pendingRun({
          approval: {
            id: 'approval-2',
            title: 'Switch',
            detail: '',
            sandboxed: true,
            modeSwap: {
              id: 'swap',
              source: AgentModeID.PLAN,
              target: AgentModeID.AGENT,
              description: '',
              status: GlyphModeSwapStatus.APPROVED,
              expiresAt: '2026-10-20T12:00:00Z',
              autoApprove: false,
            },
          },
        })}
        actions={messageActions()}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Command approval' })).toBeNull();
  });

  it('reports message action failures', async () => {
    render(
      <WiredGlyphAgentMessage
        entry={transcriptEntry()}
        actions={messageActions({ copyText: vi.fn().mockRejectedValue('Clipboard blocked') })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy message' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Clipboard blocked');
  });
});

describe(GlyphAgentMessageWithState, () => {
  it('places proposed changes before the answer', () => {
    function Message() {
      const { entries } = useGlyphMessageState({ entries: [transcriptEntry()] });
      return <GlyphAgentMessageWithState entry={entries[0]!} changes={<aside>Proposed changes</aside>} />;
    }
    render(<Message />);

    const changes = screen.getByText('Proposed changes');
    const answer = screen.getByText('All done.');
    expect(changes.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
