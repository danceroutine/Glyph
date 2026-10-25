import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { GlyphAgentInstructions } from './GlyphAgentInstructions.presentational.tsx';

const sources = [
  { id: 'root', kind: 'agents_md', label: 'AGENTS.md', path: 'AGENTS.md', scope: '.', status: 'active' },
  {
    id: 'nested',
    kind: 'agents_md',
    label: 'AGENTS.md',
    path: 'src/AGENTS.md',
    scope: 'src',
    status: 'error',
    message: 'File exceeds the read limit.',
  },
] as const;

describe(GlyphAgentInstructions, () => {
  it('renders sources and delegates opening one', () => {
    const openSource = vi.fn();
    const { container } = render(<GlyphAgentInstructions sources={sources} openSource={openSource} />);
    expect(screen.getByText('Applies to the workspace')).toBeTruthy();
    expect(screen.getByText('Applies to src/**')).toBeTruthy();
    expect(screen.getByText('File exceeds the read limit.')).toBeTruthy();
    expect(container.querySelector('[data-status="error"] svg')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Open src/AGENTS.md'));
    expect(openSource).toHaveBeenCalledWith(sources[1]);
  });

  it('filters sources and distinguishes filtered and empty states', () => {
    const { container, rerender } = render(
      <GlyphAgentInstructions sources={sources} query="src/" openSource={vi.fn()} />,
    );
    expect(container.querySelector('[title="Open AGENTS.md"]')).toBeNull();
    expect(container.querySelector('[title="Open src/AGENTS.md"]')).toBeTruthy();
    rerender(<GlyphAgentInstructions sources={sources} query="missing" openSource={vi.fn()} />);
    expect(container.textContent).toContain('No instruction files match your search.');
    rerender(<GlyphAgentInstructions sources={[]} openSource={vi.fn()} />);
    expect(container.textContent).toContain('No active instruction files were found in this workspace.');
  });
});
