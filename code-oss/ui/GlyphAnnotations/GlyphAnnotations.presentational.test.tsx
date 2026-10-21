import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import {
  GlyphAnnotationPill,
  GlyphAnnotations,
} from '#code-oss/ui/GlyphAnnotations/GlyphAnnotations.presentational.tsx';
import { useGlyphAnnotationsState } from '#code-oss/ui/GlyphAnnotations/useGlyphAnnotationsState.ts';

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});

function savedAnnotation(overrides: Partial<GlyphAnnotation> = {}): GlyphAnnotation {
  return {
    id: 'note-1',
    order: 1,
    kind: 'chat',
    sourceId: 'msg-1',
    revision: '1',
    label: 'Glyph',
    quote: 'world',
    from: 6,
    to: 11,
    comment: 'Explain',
    ...overrides,
  };
}

function mountSource(text: string): HTMLElement {
  const source = document.createElement('div');
  source.dataset.glyphSource = 'msg-1';
  source.dataset.revision = '1';
  source.dataset.kind = 'chat';
  source.style.marginTop = '300px';
  source.textContent = text;
  document.body.prepend(source);
  onTestFinished(() => source.remove());
  return source;
}

describe(GlyphAnnotationPill, () => {
  it('renders nothing without annotations', () => {
    const { container } = render(<GlyphAnnotationPill annotations={[]} />);

    expect(container.innerHTML).toBe('');
  });

  it('summarizes a single annotation without actions', () => {
    render(<GlyphAnnotationPill annotations={[savedAnnotation()]} />);

    expect(screen.getByRole('button', { name: '1 annotation' }).textContent).toBe('1 annotation');
    const article = screen.getByRole('article', { name: 'Annotation 1: Glyph', hidden: true });
    expect(article.textContent).toBe('1.Selected text:worldUser comment:Explain');
    expect(within(article).queryAllByRole('button', { hidden: true })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Remove all annotations' })).toBeNull();
  });

  it('edits, deletes and clears several annotations', () => {
    const edit = vi.fn();
    const remove = vi.fn();
    render(
      <GlyphAnnotationPill
        annotations={[savedAnnotation(), savedAnnotation({ id: 'note-2', order: 2, label: 'Plan' })]}
        edit={edit}
        remove={remove}
      />,
    );

    expect(screen.getByRole('button', { name: '2 annotations' }).textContent).toBe('2 annotations');
    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 2', hidden: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation 1', hidden: true }));
    expect(edit).toHaveBeenCalledWith('note-2');
    expect(remove).toHaveBeenCalledWith('note-1');
    remove.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Remove all annotations' }));

    expect(remove.mock.calls).toEqual([['note-1'], ['note-2']]);
  });
});

describe(GlyphAnnotations, () => {
  it('shows the selection shortcut and hides saved markers on request', () => {
    const source = mountSource('Hello world');
    const composer = new GlyphComposerState();
    composer.setDocument({ parts: [], from: 0, to: 0, options: { annotations: [savedAnnotation()] } });
    function Annotations() {
      return (
        <GlyphAnnotations
          {...useGlyphAnnotationsState({ composer, disabled: false })}
          selectionShortcut="⌘L"
          hideMarkers
        />
      );
    }
    render(<Annotations />);

    const range = document.createRange();
    range.setStart(source.firstChild!, 0);
    range.setEnd(source.firstChild!, 5);
    document.getSelection()!.addRange(range);
    fireEvent.mouseUp(document);

    expect(screen.getByRole('button', { name: 'Comment on selection' }).textContent).toBe('Add to Chat⌘L');
    expect(screen.queryByRole('button', { name: 'Edit annotation 1' })).toBeNull();
  });

  it('opens the editor inside a provided editor container', async () => {
    mountSource('Hello world');
    const container = document.createElement('div');
    document.body.append(container);
    onTestFinished(() => container.remove());
    const composer = new GlyphComposerState();
    composer.setDocument({ parts: [], from: 0, to: 0, options: { annotations: [savedAnnotation()] } });
    function Annotations() {
      return (
        <GlyphAnnotations {...useGlyphAnnotationsState({ composer, disabled: false })} editorContainer={container} />
      );
    }
    render(<Annotations />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }));

    await waitFor(() => expect(container.querySelector('form')).not.toBeNull());
    expect(container.querySelector('form')!.getAttribute('style')).toBeNull();
  });
});
