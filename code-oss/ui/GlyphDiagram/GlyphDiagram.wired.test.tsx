import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderGlyphDiagram } from '#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts';
import { WiredGlyphDiagram } from '#code-oss/ui/GlyphDiagram/GlyphDiagram.wired.tsx';

vi.mock('#code-oss/ui/GlyphDiagram/GlyphDiagramRenderer.ts', () => ({ renderGlyphDiagram: vi.fn() }));

afterEach(cleanup);

describe(WiredGlyphDiagram, () => {
  it('shows progress until the diagram image is ready', async () => {
    vi.mocked(renderGlyphDiagram).mockResolvedValue('data:image/svg+xml,diagram');

    render(<WiredGlyphDiagram source="graph TD" />);

    expect(screen.getByRole('status').textContent).toBe('Rendering diagram…');
    const image = await screen.findByRole<HTMLImageElement>('img', { name: 'Plan diagram' });
    expect(image.getAttribute('src')).toBe('data:image/svg+xml,diagram');
    expect(renderGlyphDiagram).toHaveBeenCalledWith('graph TD', true);
  });

  it('renders light diagrams inside light themes', () => {
    vi.mocked(renderGlyphDiagram).mockReturnValue(new Promise(() => {}));

    render(
      <div class="vs">
        <WiredGlyphDiagram source="graph LR" />
      </div>,
    );

    expect(renderGlyphDiagram).toHaveBeenCalledWith('graph LR', false);
  });

  it('expands to fill the view and collapses on Escape', () => {
    vi.mocked(renderGlyphDiagram).mockReturnValue(new Promise(() => {}));
    render(<WiredGlyphDiagram source="graph TD" />);

    const frame = screen.getByRole('status').parentElement!;
    expect(getComputedStyle(frame).position).toBe('relative');

    fireEvent.click(screen.getByRole('button', { name: 'Expand diagram' }));
    const collapse = screen.getByRole('button', { name: 'Collapse diagram' });
    expect(getComputedStyle(frame).position).toBe('fixed');
    collapse.blur();
    fireEvent.keyDown(window, { key: 'Escape' });

    const expand = screen.getByRole('button', { name: 'Expand diagram' });
    expect(document.activeElement).toBe(expand);
  });

  it('falls back to the diagram source when rendering fails', async () => {
    vi.mocked(renderGlyphDiagram).mockRejectedValue(new Error('bad'));

    render(<WiredGlyphDiagram source="graph ???" />);

    await waitFor(() => expect(screen.getByText('Diagram source')).toBeTruthy());
    expect(screen.getByText('graph ???').tagName).toBe('PRE');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
