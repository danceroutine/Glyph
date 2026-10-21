import type { ComponentChildren } from 'preact';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphContextCandidateKind } from '#src/desktop/workbench/GlyphContextActions.js';
import { GlyphContextPicker } from '#code-oss/ui/GlyphContextPicker/GlyphContextPicker.tsx';

afterEach(cleanup);

function Anchor({ children }: { readonly children: ComponentChildren }) {
  return (
    <div style={{ position: 'fixed', top: '600px', left: '20px', width: '700px', height: '40px' }}>{children}</div>
  );
}

describe(GlyphContextPicker, () => {
  it('lists matching files with their names and folders', () => {
    const choose = vi.fn();
    const highlight = vi.fn();
    render(
      <Anchor>
        <GlyphContextPicker
          id="picker"
          candidates={[
            { uri: 'file:///w/src/main.ts', path: 'src/main.ts' },
            { uri: 'file:///w/README.md', path: 'README.md' },
            { uri: 'file:///w/assets/logo.png', path: 'assets/logo.png', name: 'Logo' },
          ]}
          selected={0}
          searching={false}
          disabled={false}
          highlight={highlight}
          choose={choose}
        />
      </Anchor>,
    );

    expect(screen.getByRole('listbox', { name: 'Files and folders to attach' })).toBeTruthy();
    expect(screen.getByText('Files & Folders')).toBeTruthy();
    const main = screen.getByRole('option', { name: 'src/main.ts' });
    expect(main.textContent).toBe('main.tssrc/');
    expect(screen.getByRole('option', { name: 'README.md' }).textContent).toBe('README.md');
    expect(screen.getByRole('option', { name: 'assets/logo.png' }).textContent).toBe('Logoassets/');
    fireEvent.mouseEnter(screen.getByRole('option', { name: 'README.md' }));
    fireEvent.click(main);
    expect(highlight).toHaveBeenCalledWith(1);
    expect(choose).toHaveBeenCalledWith({ uri: 'file:///w/src/main.ts', path: 'src/main.ts' });
  });

  it('outlines the path of the selected file', () => {
    render(
      <Anchor>
        <GlyphContextPicker
          id="picker"
          candidates={[{ uri: 'file:///w/docs/guide/intro.md', path: 'docs/guide/intro.md' }]}
          selected={0}
          searching={false}
          disabled={false}
          highlight={vi.fn()}
          choose={vi.fn()}
        />
      </Anchor>,
    );

    const outline = screen.getAllByText('intro.md').at(-1)!.closest('[aria-hidden="true"]')!;
    expect([...outline.querySelectorAll('span')].map(part => part.textContent)).toEqual(['docs', 'guide', 'intro.md']);
    expect(outline.textContent).not.toContain('Tree outline');
  });

  it('outlines a selected folder from its ancestry', () => {
    render(
      <Anchor>
        <GlyphContextPicker
          id="picker"
          candidates={[
            {
              uri: 'file:///w/a/b/c/d/e/f/g/h',
              path: 'a/b/c/d/e/f/g/h/',
              kind: GlyphContextCandidateKind.FOLDER,
              ancestry: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
            },
          ]}
          selected={0}
          searching={false}
          disabled={false}
          highlight={vi.fn()}
          choose={vi.fn()}
        />
      </Anchor>,
    );

    const option = screen.getByRole('option', { name: 'a/b/c/d/e/f/g/h/' });
    expect(option.textContent).toBe('ha/b/c/d/e/f/g/h/');
    const outline = screen.getByText('Tree outline').closest('[aria-hidden="true"]')!;
    const branches = [...outline.firstElementChild!.children] as HTMLElement[];
    expect(branches.map(branch => branch.textContent)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    expect(branches.every(branch => branch.querySelector('svg')?.getAttribute('class')?.includes('folder'))).toBe(true);
  });

  it('shows a search status instead of a preview while searching', () => {
    render(
      <Anchor>
        <GlyphContextPicker
          id="picker"
          candidates={[{ uri: 'file:///w/notes.txt', path: 'notes.txt' }]}
          selected={0}
          searching
          disabled={false}
          highlight={vi.fn()}
          choose={vi.fn()}
        />
      </Anchor>,
    );

    expect(screen.getByRole('status').textContent).toBe('Searching files…');
    expect(screen.queryByText('notes.txt')).toBeNull();
  });

  it('reports when no files match', () => {
    render(
      <Anchor>
        <GlyphContextPicker
          id="picker"
          candidates={[]}
          selected={0}
          searching={false}
          disabled
          highlight={vi.fn()}
          choose={vi.fn()}
        />
      </Anchor>,
    );

    expect(screen.getByRole('status').textContent).toBe('No matching files');
  });

  it('picks icons by file type', () => {
    render(
      <Anchor>
        <GlyphContextPicker
          id="picker"
          candidates={[
            { uri: 'file:///w/app.tsx', path: 'app.tsx' },
            { uri: 'file:///w/notes.log', path: 'notes.log' },
            { uri: 'file:///w/photo.png', path: 'photo.png' },
          ]}
          selected={2}
          searching={false}
          disabled={false}
          highlight={vi.fn()}
          choose={vi.fn()}
        />
      </Anchor>,
    );

    const icon = (name: string) => screen.getByRole('option', { name }).querySelector('svg')!.getAttribute('class');
    expect(icon('app.tsx')).toContain('file-code');
    expect(icon('notes.log')).toContain('file-text');
    expect(icon('photo.png')).toMatch(/lucide-file(?!-)/);
  });
});
