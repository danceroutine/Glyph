import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WiredGlyphMarkdown } from '#code-oss/ui/GlyphMarkdown/GlyphMarkdown.wired.tsx';

vi.mock('#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts', () => ({
  renderGlyphDiagram: vi.fn(async () => ({ tree: { tag: 'svg', attributes: {}, children: ['diagram'] }, links: [] })),
}));

afterEach(cleanup);

describe(WiredGlyphMarkdown, () => {
  it('renders code blocks that copy through the host', async () => {
    const copyText = vi.fn(async () => {});
    render(<WiredGlyphMarkdown text={'```ts\nconst a = 1;\n```'} openLink={vi.fn()} copyText={copyText} />);

    expect(screen.getByLabelText('ts code').textContent).toContain('const a = 1;');
    fireEvent.click(screen.getByRole('button', { name: /copy/iu }));

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith('const a = 1;');
    });
  });

  it('renders Mermaid blocks as diagrams', async () => {
    render(<WiredGlyphMarkdown text={'```mermaid\ngraph TD\n```'} openLink={vi.fn()} />);

    expect((await screen.findByRole('img', { name: 'Plan diagram' })).shadowRoot?.querySelector('svg')?.textContent).toBe('diagram');
  });

  it('opens links through the host', () => {
    const openLink = vi.fn();
    render(<WiredGlyphMarkdown text="[docs](https://example.com)" openLink={openLink} />);

    fireEvent.click(screen.getByRole('link', { name: 'docs' }));

    expect(openLink).toHaveBeenCalledWith('https://example.com');
  });
});
