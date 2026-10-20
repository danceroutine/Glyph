import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { GlyphAttachmentPreview } from '#src/desktop/protocol/events/GlyphAttachmentPreview.js';
import { GlyphTranscriptRole } from '#src/desktop/workbench/GlyphTranscriptEntry.js';
import type { GlyphMessageState } from '#code-oss/ui/GlyphAgentMessage/useGlyphMessageState.ts';
import { renderGlyphDiagram } from '#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts';
import { WiredGlyphTranscriptContent } from '#code-oss/ui/GlyphTranscript/GlyphTranscriptContent.wired.tsx';

vi.mock('#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts', () => ({
  renderGlyphDiagram: vi.fn(async () => ({ tree: { tag: 'svg', attributes: {}, children: ['diagram'] }, links: [] })),
}));

afterEach(cleanup);

type ContentEntry = GlyphMessageState['entries'][number];
type ContentPart = ContentEntry['parts'][number];

const attachment = (overrides: Partial<GlyphAttachmentPreview> = {}): GlyphAttachmentPreview => ({
  path: 'src/app.ts',
  text: 'const a = 1;',
  revision: '1',
  ...overrides,
});

const attachmentPart = (preview: GlyphAttachmentPreview, label: string): ContentPart => ({
  type: 'attachment',
  attachment: preview,
  label,
  title: preview.path,
});

const contentEntry = (parts: readonly ContentPart[], overrides: Record<string, unknown> = {}) =>
  ({
    id: 'entry',
    role: GlyphTranscriptRole.USER,
    text: parts.map(part => (part.type === 'text' ? part.text : `@${part.attachment.path}`)).join(''),
    parts,
    openLink: vi.fn(),
    copyText: vi.fn(async () => {}),
    openAttachment: vi.fn(),
    ...overrides,
  }) as unknown as ContentEntry;

const predictablePlaceholders = () => {
  const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => array);
  onTestFinished(() => {
    spy.mockRestore();
  });
};

describe(WiredGlyphTranscriptContent, () => {
  it('wires known annotation citations and leaves unknown citations as text', () => {
    const annotation = {
      id: 'note',
      order: 1,
      kind: 'chat',
      sourceId: 'source',
      revision: '1',
      label: 'Glyph',
      quote: 'quoted',
      from: 0,
      to: 6,
      comment: 'Explain',
    };
    const entry = contentEntry(
      [{ type: 'text', text: '[Annotation 1](glyph-annotation:note) [Unknown](glyph-annotation:missing)' }],
      { annotation: (id: string) => (id === 'note' ? annotation : undefined) },
    );
    render(<WiredGlyphTranscriptContent entry={entry} />);
    expect(screen.getByRole('link', { name: 'Annotation 1' }).className).toBe('glyph-annotation-citation');
    expect(screen.queryByRole('link', { name: 'Unknown' })).toBeNull();
    expect(screen.getByText('Unknown')).not.toBeNull();
  });
  it('renders message text as markdown with links opened through the entry', () => {
    const entry = contentEntry([{ type: 'text', text: '**Bold** and [docs](https://example.com)' }]);
    const { container } = render(<WiredGlyphTranscriptContent entry={entry} />);

    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    fireEvent.click(screen.getByRole('link', { name: 'docs' }));

    expect(entry.openLink).toHaveBeenCalledWith('https://example.com');
  });

  it('shows attachments as badges in place that open the attachment', () => {
    const preview = attachment();
    const entry = contentEntry([
      { type: 'text', text: 'Look at ' },
      attachmentPart(preview, 'app.ts'),
      { type: 'text', text: ' please' },
    ]);
    const { container } = render(<WiredGlyphTranscriptContent entry={entry} />);

    expect(container.querySelector('p')?.textContent).toBe('Look at app.ts please');
    fireEvent.click(screen.getByRole('button', { name: 'Open src/app.ts' }));

    expect(entry.openAttachment).toHaveBeenCalledWith(preview);
  });

  it('shows attachments inside inline code as badges', () => {
    const entry = contentEntry([
      { type: 'text', text: 'Run `' },
      attachmentPart(attachment(), 'app.ts'),
      { type: 'text', text: '` now' },
    ]);
    const { container } = render(<WiredGlyphTranscriptContent entry={entry} />);

    expect(container.querySelector('code')?.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Open src/app.ts',
    );
  });

  it('writes attachments inside code blocks as mentions with their line range', async () => {
    const entry = contentEntry([
      { type: 'text', text: '```ts\n' },
      attachmentPart(attachment(), 'app.ts'),
      { type: 'text', text: ' and ' },
      attachmentPart(
        attachment({ path: 'src/b.ts', range: { start: { line: 2, column: 0 }, end: { line: 4, column: 1 } } }),
        'b.ts (2-4)',
      ),
      { type: 'text', text: '\n```' },
    ]);
    render(<WiredGlyphTranscriptContent entry={entry} />);

    expect(screen.getByLabelText('ts code').textContent).toContain('@src/app.ts and @src/b.ts (2-4)');
    fireEvent.click(screen.getByRole('button', { name: /copy/iu }));

    await waitFor(() => {
      expect(entry.copyText).toHaveBeenCalledWith('@src/app.ts and @src/b.ts (2-4)');
    });
  });

  it('labels attachments inside diagrams by name', async () => {
    const entry = contentEntry([
      { type: 'text', text: '```mermaid\ngraph TD; A[' },
      attachmentPart(attachment(), 'app.ts'),
      { type: 'text', text: ']\n```' },
    ]);
    render(<WiredGlyphTranscriptContent entry={entry} />);

    await screen.findByRole('img', { name: 'Plan diagram' });
    expect(renderGlyphDiagram).toHaveBeenLastCalledWith('graph TD; A[app.ts]', true);
  });

  it('removes review markup from agent review replies', () => {
    const entry = contentEntry(
      [{ type: 'text', text: 'Done.<glyph_review>{"findings":[]}</glyph_review> More<glyph_review>unfinished' }],
      { role: GlyphTranscriptRole.ASSISTANT, options: { agentReviewId: 'review' } },
    );
    const { container } = render(<WiredGlyphTranscriptContent entry={entry} />);

    expect(container.textContent).toBe('Done. More');
  });

  it('keeps review markup in replies that are not agent reviews', () => {
    const entry = contentEntry([{ type: 'text', text: 'Literal <glyph_review>' }], {
      role: GlyphTranscriptRole.ASSISTANT,
    });
    const { container } = render(<WiredGlyphTranscriptContent entry={entry} />);

    expect(container.textContent).toBe('Literal <glyph_review>');
  });

  it('drops placeholders that do not refer to an attachment', async () => {
    predictablePlaceholders();
    const entry = contentEntry([
      {
        type: 'text',
        text: 'A GLYPH0000CONTEXT0END B `GLYPH0000CONTEXT7END`\n\n```\nx GLYPH0000CONTEXT0END\n```\n\n```mermaid\nY GLYPH0000CONTEXT9END\n```',
      },
    ]);
    const { container } = render(<WiredGlyphTranscriptContent entry={entry} />);

    expect(container.querySelector('p')?.textContent).toBe('A  B ');
    expect(container.querySelector('button[aria-label^="Open"]')).toBeNull();
    expect(screen.getByLabelText('text code').textContent).toContain('x ');
    await screen.findByRole('img', { name: 'Plan diagram' });
    expect(renderGlyphDiagram).toHaveBeenLastCalledWith('Y ', true);
  });
});
