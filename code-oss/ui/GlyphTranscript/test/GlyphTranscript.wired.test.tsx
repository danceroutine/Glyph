import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphToolActivityStatus } from '#src/desktop/protocol/events/GlyphToolActivity.js';
import type { GlyphProposalFileSummary } from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import type { GlyphProposalSummary } from '#src/desktop/protocol/events/GlyphProposalSummary.js';
import { GlyphTranscriptRole, type GlyphTranscriptEntry } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import { aGlyphProposalFileSummary } from '#src/desktop/tests/fixtures/aGlyphProposalFileSummary.ts';
import { aGlyphProposalSummary } from '#src/desktop/tests/fixtures/aGlyphProposalSummary.ts';
import type { GlyphMessageActions } from '#code-oss/ui/GlyphAgentMessage/GlyphAgentMessage.wired.tsx';
import { WiredGlyphTranscript } from '#code-oss/ui/GlyphTranscript/GlyphTranscript.wired.tsx';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';

afterEach(cleanup);

const messageActions = (overrides: Partial<GlyphMessageActions> = {}): GlyphMessageActions => ({
  decideApproval: vi.fn(async () => {}),
  writeShellInput: vi.fn(async () => {}),
  stopShell: vi.fn(async () => {}),
  ...overrides,
});

const createdFile = (): GlyphProposalFileSummary =>
  aGlyphProposalFileSummary({ path: 'src/new.ts', operation: 'CREATE' });

const proposal = (overrides: Partial<GlyphProposalSummary> = {}) =>
  aGlyphProposalSummary({ id: 'proposal-1', files: [createdFile()], ...overrides });

const assistantReply = (summary?: string): GlyphTranscriptEntry => ({
  id: 'reply',
  role: GlyphTranscriptRole.ASSISTANT,
  text: 'Created the file.',
  progress: {
    status: GlyphRunStatus.COMPLETED,
    reasoning: '',
    tools: [
      {
        id: 'tool',
        name: 'propose_edit',
        status: GlyphToolActivityStatus.COMPLETED,
        ...(summary === undefined ? {} : { summary }),
      },
    ],
  },
});

describe(WiredGlyphTranscript, () => {
  it('reveals a cited native proposal through the conversation composer', async () => {
    const composer = new GlyphComposerState();
    const reveal = vi.fn(async () => ({ x: 10, y: 20 }));
    composer.registerAnnotationSource('proposal:file', reveal);
    const annotation = {
      id: 'note',
      order: 1,
      kind: 'proposal' as const,
      sourceId: 'proposal:file',
      revision: '1',
      label: 'file',
      quote: 'text',
      from: 0,
      to: 4,
      comment: 'Explain',
    };
    render(
      <WiredGlyphTranscript
        actions={messageActions({ composer })}
        entries={[
          { id: 'feedback', role: GlyphTranscriptRole.USER, text: 'Feedback', options: { annotations: [annotation] } },
          { id: 'reply', role: GlyphTranscriptRole.ASSISTANT, text: '[Annotation 1](glyph-annotation:note)' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('link', { name: 'Annotation 1' }));
    await waitFor(() => {
      expect(reveal).toHaveBeenCalledWith(annotation);
    });
  });
  it('renders user and assistant messages in order with plans after them', () => {
    render(
      <WiredGlyphTranscript
        entries={[
          { id: 'ask', role: GlyphTranscriptRole.USER, text: 'Please help' },
          { id: 'answer', role: GlyphTranscriptRole.ASSISTANT, text: 'Sure thing' },
        ]}
        plans={<aside>Plans</aside>}
      />,
    );

    const log = screen.getByRole('log', { name: 'Glyph conversation' });
    expect([...log.querySelectorAll('[data-glyph-source]')].map(source => source.textContent)).toEqual([
      'Please help',
      'Sure thing',
    ]);
    expect(log.lastElementChild?.textContent).toBe('Plans');
    expect(screen.queryByRole('button', { name: 'Restore checkpoint' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Branch chat' })).toBeNull();
  });

  it('scrolls to the newest message', () => {
    render(
      <div style={{ display: 'flex', flexDirection: 'column', height: '120px' }}>
        <WiredGlyphTranscript
          entries={Array.from({ length: 20 }, (_, index) => ({
            id: `message-${index}`,
            role: GlyphTranscriptRole.USER,
            text: `Message ${index}`,
          }))}
        />
      </div>,
    );

    const log = screen.getByRole('log');
    expect(log.scrollTop).toBeGreaterThan(0);
    expect(Math.abs(log.scrollTop - (log.scrollHeight - log.clientHeight))).toBeLessThanOrEqual(1);
  });

  it('restores checkpoints and branches chats through the host', async () => {
    const restoreCheckpoint = vi.fn(async () => {});
    const branchChat = vi.fn(async () => {});
    render(
      <WiredGlyphTranscript
        chatId="chat"
        actions={messageActions({ restoreCheckpoint, branchChat })}
        entries={[
          { id: 'ask', role: GlyphTranscriptRole.USER, text: 'Hi', checkpointTurnId: 'turn-1' },
          { id: 'answer', role: GlyphTranscriptRole.ASSISTANT, text: 'Hello', checkpointTurnId: 'turn-2' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restore checkpoint' }));
    await waitFor(() => {
      expect(restoreCheckpoint).toHaveBeenCalledWith('chat', 'turn-1');
    });
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Branch chat' }).disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Branch chat' }));

    await waitFor(() => {
      expect(branchChat).toHaveBeenCalledWith('chat', 'turn-2');
    });
  });

  it.each([
    ['in a read-only window', { chatId: 'chat', readOnly: true }],
    ['without a chat', {}],
  ])('offers no history actions %s', (_, props) => {
    render(
      <WiredGlyphTranscript
        {...props}
        actions={messageActions({ restoreCheckpoint: vi.fn(async () => {}), branchChat: vi.fn(async () => {}) })}
        entries={[
          { id: 'ask', role: GlyphTranscriptRole.USER, text: 'Hi', checkpointTurnId: 'turn-1' },
          { id: 'answer', role: GlyphTranscriptRole.ASSISTANT, text: 'Hello', checkpointTurnId: 'turn-2' },
        ]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Restore checkpoint' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Branch chat' })).toBeNull();
  });

  it('shows file changes proposed by a reply and reviews them through the host', async () => {
    const reviewProposalFile = vi.fn(async () => {});
    render(
      <WiredGlyphTranscript
        chatId="chat"
        actions={messageActions({ reviewProposalFile })}
        proposals={[proposal(), proposal({ id: 'proposal-2' }), proposal({ id: 'proposal-1', chatId: 'other' })]}
        entries={[assistantReply('Proposed proposal-1')]}
      />,
    );

    expect(screen.getAllByRole('region', { name: 'File change src/new.ts' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /new\.ts/u }));

    await waitFor(() => {
      expect(reviewProposalFile).toHaveBeenCalledWith('chat', 'proposal-1', 'file');
    });
  });

  it('shows no file changes for replies without matching tool results', () => {
    render(
      <WiredGlyphTranscript
        chatId="chat"
        proposals={[proposal()]}
        entries={[assistantReply(), { id: 'plain', role: GlyphTranscriptRole.ASSISTANT, text: 'No tools' }]}
      />,
    );

    expect(screen.queryByRole('region', { name: /File change/u })).toBeNull();
  });

  it('does not review file changes without a chat or a host that reviews them', () => {
    const reviewProposalFile = vi.fn(async () => {});
    render(
      <WiredGlyphTranscript
        actions={messageActions({ reviewProposalFile })}
        proposals={[{ id: 'proposal-1', createdAt: '2026-01-01T00:00:00.000Z', files: [createdFile()] }]}
        entries={[assistantReply('proposal-1')]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /new\.ts/u }));
    cleanup();

    render(<WiredGlyphTranscript chatId="chat" proposals={[proposal()]} entries={[assistantReply('proposal-1')]} />);
    fireEvent.click(screen.getByRole('button', { name: /new\.ts/u }));
    cleanup();

    render(
      <WiredGlyphTranscript
        chatId="chat"
        actions={messageActions()}
        proposals={[proposal()]}
        entries={[assistantReply('proposal-1')]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /new\.ts/u }));

    expect(reviewProposalFile).not.toHaveBeenCalled();
  });
});
