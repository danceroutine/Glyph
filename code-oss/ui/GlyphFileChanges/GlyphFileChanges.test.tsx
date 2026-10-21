import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GlyphProposalApplicability,
  type GlyphProposalFileSummary,
} from '#src/desktop/protocol/events/GlyphProposalFileSummary.js';
import { GlyphFileChanges } from '#code-oss/ui/GlyphFileChanges/GlyphFileChanges.tsx';

afterEach(cleanup);

const file = (overrides: Partial<GlyphProposalFileSummary>): GlyphProposalFileSummary => ({
  id: 'file',
  path: 'src/app.ts',
  proposedUri: 'glyph://proposal/file',
  pendingItemIds: ['item'],
  applicability: GlyphProposalApplicability.READY,
  ...overrides,
});

describe(GlyphFileChanges, () => {
  it('shows only created, deleted and renamed files', () => {
    render(
      <GlyphFileChanges
        files={[
          file({ id: 'a', path: 'a.ts' }),
          file({ id: 'b', path: 'b.ts', operation: 'UPDATE' }),
          file({ id: 'c', path: 'c.ts', operation: 'CREATE' }),
          file({ id: 'd', path: 'd.ts', operation: 'DELETE' }),
          file({ id: 'e', path: 'e.ts', operation: 'RENAME' }),
        ]}
        review={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual([
      'File change c.ts',
      'File change d.ts',
      'File change e.ts',
    ]);
  });

  it('opens the review of a file from its header', () => {
    const review = vi.fn();
    render(<GlyphFileChanges files={[file({ id: 'created', operation: 'CREATE' })]} review={review} />);

    fireEvent.click(screen.getByRole('button', { name: /app\.ts/ }));

    expect(review).toHaveBeenCalledWith('created');
  });

  it('summarizes a created file with its name, line counts and highlighted additions', () => {
    render(
      <GlyphFileChanges
        files={[
          file({
            path: 'src/deep/app.ts',
            operation: 'CREATE',
            additions: 2,
            deletions: 1,
            afterPreview: 'const a = 1;\n',
          }),
        ]}
        review={vi.fn()}
      />,
    );

    const header = screen.getByRole('button', { name: /app\.ts/ });
    expect(header.getAttribute('title')).toBe('src/deep/app.ts');
    expect(header.textContent).toContain('+2');
    expect(header.textContent).toContain('−1');
    const preview = screen.getByRole('region').querySelector('pre')!;
    expect(preview.style.background).toContain('--vscode-diffEditor-insertedTextBackground');
    const rows = [...preview.children];
    expect(rows.map(row => row.textContent)).toEqual(['1+const a = 1;', '2+ ']);
    expect(rows[0]!.querySelector('.hljs-keyword')?.textContent).toBe('const');
  });

  it('previews the removed content of a deleted file', () => {
    render(
      <GlyphFileChanges
        files={[file({ path: 'notes.md', operation: 'DELETE', beforePreview: '# Old', afterPreview: 'ignored' })]}
        review={vi.fn()}
      />,
    );

    const preview = screen.getByRole('region').querySelector('pre')!;
    expect(preview.style.background).toContain('--vscode-diffEditor-removedTextBackground');
    expect(preview.textContent).toBe('1−# Old');
    expect(preview.querySelector('.hljs-section')?.textContent).toBe('# Old');
  });

  it('previews a renamed file neutrally with a rename badge and no line counts', () => {
    render(
      <GlyphFileChanges
        files={[file({ path: 'script.py', operation: 'RENAME', afterPreview: 'def run(): pass' })]}
        review={vi.fn()}
      />,
    );

    const header = screen.getByRole('button', { name: /script\.py/ });
    expect(screen.getByLabelText('Renamed')).toBeTruthy();
    expect(header.textContent).not.toContain('+');
    expect(header.textContent).not.toContain('−');
    const preview = screen.getByRole('region').querySelector('pre')!;
    expect(preview.style.background).toBe('transparent');
    expect(preview.textContent).toBe('1 def run(): pass');
    expect(preview.querySelector('.hljs-keyword')?.textContent).toBe('def');
  });

  it('shows text in unknown languages without highlighting', () => {
    render(
      <GlyphFileChanges
        files={[file({ path: 'data.unknownext', operation: 'CREATE', afterPreview: 'plain\n' })]}
        review={vi.fn()}
      />,
    );

    const code = [...screen.getByRole('region').querySelectorAll('code')];
    expect(code.map(line => line.textContent)).toEqual(['plain', ' ']);
    expect(code.some(line => line.querySelector('span'))).toBe(false);
  });

  it('omits the preview when the change has no content to show', () => {
    render(<GlyphFileChanges files={[file({ operation: 'DELETE', afterPreview: 'unused' })]} review={vi.fn()} />);

    expect(screen.getByRole('region').querySelector('pre')).toBeNull();
  });
});
