import { act, cleanup, renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { useGlyphAnnotationsState } from '#code-oss/ui/GlyphAnnotations/useGlyphAnnotationsState.ts';

afterEach(cleanup);

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

describe(useGlyphAnnotationsState, () => {
  it('exposes the annotations of the prompt as they change', () => {
    const composer = new GlyphComposerState();
    const { result } = renderHook(useGlyphAnnotationsState, { initialProps: { composer, disabled: false } });
    expect(result.current.annotations).toEqual([]);

    act(() => composer.setDocument({ parts: [], from: 0, to: 0, options: { annotations: [savedAnnotation()] } }));

    expect(result.current.annotations).toEqual([savedAnnotation()]);
    expect(result.current.editorPosition).toEqual({ x: 8, y: 8 });
    expect(result.current.disabled).toBe(false);
  });

  it('edits and removes annotations through the composer', () => {
    const composer = new GlyphComposerState();
    composer.setDocument({ parts: [], from: 0, to: 0, options: { annotations: [savedAnnotation()] } });
    const { result } = renderHook(useGlyphAnnotationsState, { initialProps: { composer, disabled: false } });

    act(() => result.current.edit('note-1'));
    expect(composer.snapshot.editingAnnotation).toBe('note-1');
    act(() => result.current.remove('note-1'));

    expect(composer.snapshot.document.options?.annotations).toEqual([]);
    expect(composer.snapshot.editingAnnotation).toBeUndefined();
  });

  it('does nothing when opening without a selection or submitting without a draft', () => {
    const composer = new GlyphComposerState();
    const save = vi.spyOn(composer, 'saveAnnotation');
    const { result } = renderHook(useGlyphAnnotationsState, { initialProps: { composer, disabled: false } });

    act(() => result.current.open());
    act(() => result.current.setComment('Orphan comment'));
    act(() => result.current.submit());

    expect(result.current.draft).toBeUndefined();
    expect(result.current.comment).toBe('Orphan comment');
    expect(save).not.toHaveBeenCalled();
  });
});
