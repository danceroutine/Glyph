import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { WiredGlyphAnnotations } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotations.wired.tsx';

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});

interface SourceOptions {
  readonly id?: string;
  readonly revision?: string;
  readonly kind?: string;
  readonly label?: string | null;
  readonly style?: string;
  readonly html?: string;
}

function mountSource(text: string, options: SourceOptions = {}): HTMLElement {
  const source = document.createElement('div');
  source.dataset.glyphSource = options.id ?? 'msg-1';
  source.dataset.revision = options.revision ?? '1';
  source.dataset.kind = options.kind ?? 'chat';
  if (options.label !== null) source.dataset.label = options.label ?? 'Glyph';
  source.setAttribute('style', options.style ?? 'margin-top: 300px; width: 300px');
  if (options.html === undefined) source.textContent = text;
  else source.innerHTML = options.html;
  document.body.prepend(source);
  onTestFinished(() => {
    source.remove();
  });
  return source;
}

function selectRange(range: Range) {
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(document);
}

function selectText(node: Node, from: number, to: number) {
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  selectRange(range);
  return range;
}

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

function composerWith(annotations: readonly GlyphAnnotation[] = []): GlyphComposerState {
  const composer = new GlyphComposerState();
  composer.setDocument({ parts: [], from: 0, to: 0, options: { annotations } });
  return composer;
}

function editor() {
  return screen.queryByRole('form', { name: 'Annotation editor' });
}

describe(WiredGlyphAnnotations, () => {
  it('turns a selection in a message into a saved annotation', () => {
    const source = mountSource('Hello world');
    const composer = composerWith();
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);

    selectText(source.firstChild!, 6, 11);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));
    const comment = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Annotation comment' });
    expect(screen.queryByRole('button', { name: 'Comment on selection' })).toBeNull();
    expect(document.activeElement).toBe(comment);
    expect(comment.getAttribute('aria-description')).toBe('Comment on: world');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save annotation' }).disabled).toBe(true);
    fireEvent.input(comment, { target: { value: '  Explain this  ' } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save annotation' }).disabled).toBe(false);
    fireEvent.keyDown(comment, { key: 'Enter' });

    expect(composer.snapshot.document.options?.annotations).toEqual([
      expect.objectContaining({
        order: 1,
        kind: 'chat',
        sourceId: 'msg-1',
        revision: '1',
        label: 'Glyph',
        quote: 'world',
        from: 6,
        to: 11,
        comment: 'Explain this',
      }),
    ]);
    expect(editor()).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit annotation 1' })).toBeTruthy();
  });

  it('renders into the workbench when one is present', () => {
    const workbench = document.createElement('div');
    workbench.className = 'monaco-workbench';
    document.body.append(workbench);
    onTestFinished(() => {
      workbench.remove();
    });
    const source = mountSource('Hello world');
    render(<WiredGlyphAnnotations composer={composerWith()} disabled={false} />);

    selectText(source.firstChild!, 0, 5);

    expect(workbench.contains(screen.getByRole('button', { name: 'Comment on selection' }))).toBe(true);
  });

  it('places the editor above a selection when there is room', () => {
    const source = mountSource('Hello world');
    render(<WiredGlyphAnnotations composer={composerWith()} disabled={false} />);
    const range = selectText(source.firstChild!, 6, 11);

    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));

    expect(editor()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(range.getBoundingClientRect().top);
  });

  it('places the editor below a selection near the top of the view', () => {
    const source = mountSource('Hello world', { style: 'margin-top: 0; width: 300px' });
    render(<WiredGlyphAnnotations composer={composerWith()} disabled={false} />);
    const range = selectText(source.firstChild!, 6, 11);

    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));

    expect(editor()!.getBoundingClientRect().top).toBeGreaterThanOrEqual(range.getBoundingClientRect().bottom);
  });

  it('withdraws the offer when the selection collapses or leaves messages', () => {
    const source = mountSource('Hello world');
    const outside = document.createElement('p');
    outside.textContent = 'Outside';
    document.body.append(outside);
    onTestFinished(() => {
      outside.remove();
    });
    render(<WiredGlyphAnnotations composer={composerWith()} disabled={false} />);
    const offer = () => screen.queryByRole('button', { name: 'Comment on selection' });

    selectText(source.firstChild!, 0, 5);
    expect(offer()).not.toBeNull();
    document.getSelection()!.collapseToStart();
    fireEvent.mouseUp(document);
    expect(offer()).toBeNull();

    selectText(source.firstChild!, 0, 5);
    selectText(outside.firstChild!, 0, 3);
    expect(offer()).toBeNull();

    selectText(source.firstChild!, 0, 5);
    const across = document.createRange();
    across.setStart(source.firstChild!, 0);
    across.setEnd(outside.firstChild!, 3);
    selectRange(across);
    expect(offer()).toBeNull();

    selectText(source.firstChild!, 0, 5);
    document.getSelection()!.removeAllRanges();
    fireEvent.keyUp(document);
    expect(offer()).toBeNull();
  });

  it('ignores blank and oversized selections', () => {
    const blank = mountSource('Hello     world');
    const huge = mountSource('x'.repeat(50001), { id: 'msg-2', style: 'width: 300px; word-break: break-all' });
    render(<WiredGlyphAnnotations composer={composerWith()} disabled={false} />);

    selectText(blank.firstChild!, 5, 10);
    expect(screen.queryByRole('button', { name: 'Comment on selection' })).toBeNull();
    selectText(huge.firstChild!, 0, 50001);

    expect(screen.queryByRole('button', { name: 'Comment on selection' })).toBeNull();
  });

  it('ignores selections while disabled', () => {
    const source = mountSource('Hello world');
    render(<WiredGlyphAnnotations composer={composerWith()} disabled />);

    selectText(source.firstChild!, 0, 5);

    expect(screen.queryByRole('button', { name: 'Comment on selection' })).toBeNull();
  });

  it('labels whole-element selections from unlabeled proposal sources', () => {
    const source = mountSource('Proposed text', { kind: 'proposal', label: null });
    const composer = composerWith([savedAnnotation({ id: 'old', order: 4, sourceId: 'elsewhere' })]);
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);
    const range = document.createRange();
    range.selectNodeContents(source);

    selectRange(range);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));
    fireEvent.input(screen.getByRole('textbox', { name: 'Annotation comment' }), { target: { value: 'Why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save annotation' }));

    expect(composer.snapshot.document.options?.annotations?.at(-1)).toEqual(
      expect.objectContaining({ kind: 'proposal', label: 'Selected text', quote: 'Proposed text', from: 0, to: 13 }),
    );
    expect(editor()).toBeNull();
  });

  it('keeps the editor open for new lines and composition but closes it on Escape or cancel', () => {
    const source = mountSource('Hello world');
    const composer = composerWith();
    const edit = vi.spyOn(composer, 'editAnnotation');
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);
    selectText(source.firstChild!, 0, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));
    const comment = screen.getByRole('textbox', { name: 'Annotation comment' });
    fireEvent.input(comment, { target: { value: 'Note' } });

    fireEvent.keyDown(comment, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(comment, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(comment, { key: 'a' });
    expect(editor()).not.toBeNull();
    fireEvent.keyDown(comment, { key: 'Escape' });
    expect(editor()).toBeNull();
    expect(edit).toHaveBeenLastCalledWith(undefined);

    selectText(source.firstChild!, 0, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel annotation' }));

    expect(editor()).toBeNull();
    expect(composer.snapshot.document.options?.annotations).toEqual([]);
  });

  it('saves nothing without a comment or while disabled', () => {
    const source = mountSource('Hello world');
    const composer = composerWith();
    const { rerender } = render(<WiredGlyphAnnotations composer={composer} disabled={false} />);
    selectText(source.firstChild!, 0, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));
    const comment = screen.getByRole('textbox', { name: 'Annotation comment' });

    fireEvent.input(comment, { target: { value: '   ' } });
    fireEvent.keyDown(comment, { key: 'Enter' });
    fireEvent.input(comment, { target: { value: 'Valid' } });
    rerender(<WiredGlyphAnnotations composer={composer} disabled />);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save annotation' }).disabled).toBe(true);
    fireEvent.keyDown(comment, { key: 'Enter' });

    expect(composer.snapshot.document.options?.annotations).toEqual([]);
    expect(editor()).not.toBeNull();
  });

  it('closes the editor while the message is being sent', () => {
    const source = mountSource('Hello world');
    const composer = composerWith();
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);
    selectText(source.firstChild!, 0, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));

    act(() => {
      composer.setDraft('Send this');
      void composer.submit(() => new Promise(() => {}));
    });

    expect(editor()).toBeNull();
  });

  it('reopens saved annotations from their markers and updates them', async () => {
    const source = mountSource('', { html: 'Hello <b>big</b> world' });
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    onTestFinished(() => {
      scroll.mockRestore();
    });
    const composer = composerWith([savedAnnotation({ quote: 'big world', from: 6, to: 15 })]);
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }));
    const comment = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Annotation comment' });
    expect(comment.value).toBe('Explain');
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    expect(scroll.mock.contexts[0]).toBe(source);
    fireEvent.input(comment, { target: { value: 'Explain more' } });
    fireEvent.submit(editor()!);

    expect(composer.snapshot.document.options?.annotations).toEqual([
      expect.objectContaining({ id: 'note-1', order: 1, comment: 'Explain more' }),
    ]);
    expect(editor()).toBeNull();
  });

  it('marks only annotations whose text is still visible', () => {
    mountSource('Hello world');
    mountSource('Hello world', { id: 'hidden', style: 'display: none' });
    mountSource('Hello world', { id: 'below', style: 'position: fixed; top: 5000px' });
    mountSource('Hello world', { id: 'above', style: 'position: fixed; top: -500px' });
    render(
      <WiredGlyphAnnotations
        composer={composerWith([
          savedAnnotation({ id: 'visible', order: 1 }),
          savedAnnotation({ id: 'stale', order: 2, revision: '2' }),
          savedAnnotation({ id: 'changed', order: 3, quote: 'earth' }),
          savedAnnotation({ id: 'overflow', order: 4, to: 40 }),
          savedAnnotation({ id: 'hidden', order: 5, sourceId: 'hidden' }),
          savedAnnotation({ id: 'below', order: 6, sourceId: 'below' }),
          savedAnnotation({ id: 'above', order: 7, sourceId: 'above' }),
        ])}
        disabled={false}
      />,
    );

    expect(screen.getAllByRole('button', { name: /^Edit annotation/u }).map(button => button.textContent)).toEqual([
      '1',
    ]);
  });

  it('moves markers with their text and drops them when the text changes', async () => {
    const source = mountSource('Hello world');
    render(<WiredGlyphAnnotations composer={composerWith([savedAnnotation()])} disabled={false} />);
    const marker = () => screen.queryByRole('button', { name: 'Edit annotation 1' });
    const top = marker()!.getBoundingClientRect().top;

    fireEvent(window, new Event('resize'));
    expect(marker()!.getBoundingClientRect().top).toBe(top);
    source.style.marginTop = '350px';
    fireEvent.scroll(document);
    expect(marker()!.getBoundingClientRect().top).toBe(top + 50);
    act(() => {
      source.textContent = 'Hello there';
    });

    await waitFor(() => {
      expect(marker()).toBeNull();
    });
  });

  it('withdraws the selection offer once its text changes', () => {
    const source = mountSource('Hello world');
    render(<WiredGlyphAnnotations composer={composerWith()} disabled={false} />);
    selectText(source.firstChild!, 6, 11);

    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('button', { name: 'Comment on selection' })).not.toBeNull();
    source.firstChild!.textContent = 'Hello there';
    fireEvent(window, new Event('resize'));

    expect(screen.queryByRole('button', { name: 'Comment on selection' })).toBeNull();
  });

  it('keeps the editor with its text as the layout changes, even after the text disappears', () => {
    const source = mountSource('Hello world');
    render(<WiredGlyphAnnotations composer={composerWith()} disabled={false} />);
    selectText(source.firstChild!, 6, 11);
    fireEvent.click(screen.getByRole('button', { name: 'Comment on selection' }));
    const top = editor()!.getBoundingClientRect().top;

    source.style.marginTop = '400px';
    fireEvent(window, new Event('resize'));
    expect(editor()!.getBoundingClientRect().top).toBeGreaterThan(top);
    source.remove();
    fireEvent(window, new Event('resize'));

    expect(editor()).not.toBeNull();
  });

  it('opens annotations requested elsewhere at their reported position', async () => {
    const composer = composerWith();
    composer.registerAnnotationSource('plan-1', async () => ({ x: 500, y: 400, minX: 100, maxX: 380 }));

    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);
    act(() => {
      composer.requestAnnotation(savedAnnotation({ sourceId: 'plan-1', comment: 'From plan' }));
    });

    const comment = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Annotation comment' });
    expect(comment.value).toBe('From plan');
    const bounds = editor()!.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(100);
    expect(bounds.left).toBeLessThanOrEqual(Math.max(100, 380 - bounds.width));
    expect(bounds.bottom).toBeLessThanOrEqual(400);
  });

  it('opens annotations requested elsewhere inside their editor', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    onTestFinished(() => {
      container.remove();
    });
    const composer = composerWith();
    composer.registerAnnotationSource('editor-1', async () => ({ x: 0, y: 0, container }));

    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);
    act(() => {
      composer.requestAnnotation(savedAnnotation({ sourceId: 'editor-1' }));
    });

    await waitFor(() => {
      expect(container.querySelector('form')).not.toBeNull();
    });
    expect(container.querySelector('form')!.getAttribute('style')).toBeNull();
  });

  it('falls back to a default position when no view can reveal the annotation', async () => {
    const composer = composerWith();
    composer.registerAnnotationSource('broken', async () => {
      throw new Error('Gone');
    });
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);

    act(() => {
      composer.requestAnnotation(savedAnnotation({ sourceId: 'unknown' }));
    });
    await screen.findByRole('textbox', { name: 'Annotation comment' });
    act(() => {
      composer.editAnnotation(undefined);
    });
    act(() => {
      composer.requestAnnotation(savedAnnotation({ id: 'note-2', sourceId: 'broken' }));
    });

    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Explain');
    });
  });

  it('ignores a reveal that finishes after the request was withdrawn', async () => {
    let reveal!: (position: { x: number; y: number }) => void;
    const composer = composerWith();
    composer.registerAnnotationSource(
      'slow',
      () =>
        new Promise(resolve => {
          reveal = resolve;
        }),
    );
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);

    act(() => {
      composer.requestAnnotation(savedAnnotation({ sourceId: 'slow' }));
    });
    act(() => {
      composer.editAnnotation(undefined);
    });
    await act(async () => {
      reveal({ x: 10, y: 10 });
    });

    expect(editor()).toBeNull();
  });

  it('closes an annotation that is deleted while it is being edited', async () => {
    mountSource('Hello world');
    const composer = composerWith([savedAnnotation()]);
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }));
    await screen.findByRole('textbox', { name: 'Annotation comment' });

    act(() => {
      composer.removeAnnotation('note-1');
    });

    await waitFor(() => {
      expect(editor()).toBeNull();
    });
  });

  it('keeps editing a saved annotation when the edit request is cleared elsewhere', async () => {
    mountSource('Hello world');
    const composer = composerWith([savedAnnotation()]);
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }));
    await screen.findByRole('textbox', { name: 'Annotation comment' });

    act(() => {
      composer.editAnnotation(undefined);
    });

    expect(editor()).not.toBeNull();
  });

  it('keeps an unsaved annotation open when the request is cleared', async () => {
    const composer = composerWith();
    render(<WiredGlyphAnnotations composer={composer} disabled={false} />);
    act(() => {
      composer.requestAnnotation(savedAnnotation({ comment: '' }));
    });
    await screen.findByRole('textbox', { name: 'Annotation comment' });

    act(() => {
      composer.editAnnotation(undefined);
    });

    expect(editor()).not.toBeNull();
  });
});
