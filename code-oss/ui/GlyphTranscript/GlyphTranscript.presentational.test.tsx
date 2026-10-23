import { createRef } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import {
  GlyphTranscript,
  GlyphTranscriptMessage,
  type GlyphTranscriptMessageProps,
} from '#code-oss/ui/GlyphTranscript/GlyphTranscript.presentational.tsx';

afterEach(cleanup);

const messageEntry = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'entry',
    role: GlyphTranscriptRole.USER,
    text: 'Hello there',
    label: 'You',
    historyPending: false,
    openLink: vi.fn(),
    ...overrides,
  }) as unknown as GlyphTranscriptMessageProps['entry'];

describe(GlyphTranscript, () => {
  it('shows the conversation log followed by plans', () => {
    const transcript = createRef<HTMLDivElement>();
    render(
      <GlyphTranscript transcript={transcript} plans={<aside>Plans</aside>}>
        <p>Message</p>
      </GlyphTranscript>,
    );

    const log = screen.getByRole('log', { name: 'Glyph conversation' });
    expect(transcript.current).toBe(log);
    expect([...log.children].map(child => child.textContent)).toEqual(['Message', 'Plans']);
  });
});

describe(GlyphTranscriptMessage, () => {
  it('shows a user message in a bubble with its content source', () => {
    const { container } = render(<GlyphTranscriptMessage entry={messageEntry()} content={<p>Hello there</p>} />);

    const row = container.firstElementChild as HTMLElement;
    expect(row.classList.contains('user')).toBe(true);
    const source = row.querySelector<HTMLElement>('[data-glyph-source="entry"]')!;
    expect(source.dataset.kind).toBe('chat');
    expect(source.dataset.label).toBe('You');
    expect(source.dataset.revision).toBe('11');
    expect(source.textContent).toBe('Hello there');
    expect(Object.hasOwn(source.parentElement!.dataset, 'steering')).toBe(false);
    expect(row.querySelector('strong')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore checkpoint' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('marks steering messages with a distinct bubble', () => {
    const { container } = render(<GlyphTranscriptMessage entry={messageEntry()} content={null} />);
    const regular = container.querySelector('[data-glyph-source]')!.parentElement!.className;
    cleanup();

    const steering = render(<GlyphTranscriptMessage entry={messageEntry({ steering: true })} content={null} />);
    const bubble = steering.container.querySelector<HTMLElement>('[data-glyph-source]')!.parentElement!;

    expect(bubble.dataset.steering).toBe('true');
    expect(bubble.className).not.toBe(regular);
  });

  it('restores the checkpoint of a user message', () => {
    const restore = vi.fn();
    render(<GlyphTranscriptMessage entry={messageEntry({ restore })} content={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore checkpoint' }));

    expect(restore).toHaveBeenCalledOnce();
  });

  it('cannot restore while history is changing', () => {
    render(<GlyphTranscriptMessage entry={messageEntry({ restore: vi.fn(), historyPending: true })} content={null} />);

    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Restore checkpoint' }).disabled).toBe(true);
  });

  it('labels diagnostic messages and never offers restoring them', () => {
    const { container } = render(
      <GlyphTranscriptMessage
        entry={messageEntry({ role: GlyphTranscriptRole.DIAGNOSTIC, label: 'Status', restore: vi.fn() })}
        content={<p>Reconnected</p>}
      />,
    );

    expect(container.querySelector('strong')?.textContent).toBe('Status');
    expect(screen.queryByRole('button', { name: 'Restore checkpoint' })).toBeNull();
  });

  it('shows submitted answers, turn progress, annotations and attachment errors', () => {
    render(
      <GlyphTranscriptMessage
        entry={messageEntry({
          questionResponses: [{ id: 'response', answers: [{ question: 'Color?', answer: 'Blue' }] }],
          progress: { status: GlyphRunStatus.COMPLETED, reasoning: 'Considered options', tools: [] },
          options: {
            annotations: [
              {
                id: 'note',
                order: 1,
                kind: 'chat',
                sourceId: 'entry',
                revision: '1',
                label: 'Chat',
                quote: 'Hello',
                from: 0,
                to: 5,
                comment: 'Be brief',
              },
            ],
          },
          attachmentError: 'File moved',
        })}
        content={null}
      />,
    );

    expect(screen.getByRole('region', { name: 'Submitted answers' }).textContent).toBe('Color?Blue');
    expect(screen.getByRole('region', { name: 'Turn progress' }).textContent).toContain('Reasoning summary');
    expect(screen.getByRole('button', { name: '1 annotation' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('File moved');
  });
});
