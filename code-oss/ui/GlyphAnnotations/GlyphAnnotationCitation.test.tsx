import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/preact';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { WiredGlyphAnnotationCitation } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotationCitation.wired.tsx';
import {
  annotationRevealDuration,
  useGlyphAnnotationCitationState,
} from '#code-oss/ui/GlyphAnnotations/useGlyphAnnotationCitationState.ts';
import { annotationRange, annotationSourceRange } from '#code-oss/ui/GlyphAnnotations/GlyphAnnotationSource.ts';

const annotation: GlyphAnnotation = {
  id: 'note',
  order: 1,
  kind: 'chat',
  sourceId: 'message',
  revision: '1',
  label: 'Glyph',
  quote: 'world',
  from: 6,
  to: 11,
  comment: 'Explain this',
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function source() {
  const node = document.createElement('div');
  node.dataset.glyphSource = 'message';
  node.dataset.revision = '1';
  node.append('Hello ', document.createTextNode('world'));
  document.body.prepend(node);
  onTestFinished(() => {
    node.remove();
  });
  return node;
}

it('previews captured text on hover and focus, dismisses with Escape, and keeps scrolling inside the preview open', async () => {
  const layer = document.createElement('div');
  layer.className = 'monaco-workbench';
  document.body.append(layer);
  onTestFinished(() => {
    layer.remove();
  });
  render(<WiredGlyphAnnotationCitation annotation={annotation}>Annotation 1</WiredGlyphAnnotationCitation>);
  let link = screen.getByRole('link');
  fireEvent.keyDown(link, { key: 'Escape' });
  fireEvent.mouseEnter(link);
  await waitFor(() => {
    expect(screen.getByRole('tooltip').textContent).toContain('Explain this');
  });
  const preview = screen.getByRole('tooltip');
  expect(layer.contains(preview)).toBe(true);
  expect(preview.textContent).toContain('world');
  fireEvent.scroll(preview);
  fireEvent.keyDown(link, { key: 'x' });
  expect(screen.queryByRole('tooltip')).not.toBeNull();
  fireEvent.mouseLeave(link);
  fireEvent.mouseEnter(preview);
  await new Promise(resolve => {
    setTimeout(resolve, 150);
  });
  expect(screen.queryByRole('tooltip')).not.toBeNull();
  fireEvent.mouseLeave(preview);
  await waitFor(() => {
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  link = screen.getByRole('link');
  act(() => {
    link.focus();
  });
  await waitFor(() => {
    expect(screen.queryByRole('tooltip')).not.toBeNull();
  });
  fireEvent.keyDown(link, { key: 'Escape' });
  expect(screen.queryByRole('tooltip')).toBeNull();
  act(() => {
    link.blur();
    screen.getByRole('link').focus();
  });
  fireEvent.scroll(document);
  await waitFor(() => {
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  act(() => {
    screen.getByRole('link').blur();
    screen.getByRole('link').focus();
  });
  act(() => {
    screen.getByRole('link').blur();
  });
  expect(screen.queryByRole('tooltip')).toBeNull();
});

it('reveals only the matching live passage and clears temporary highlights', async () => {
  vi.useFakeTimers();
  const node = source();
  const scroll = vi.spyOn(node, 'scrollIntoView');
  render(<WiredGlyphAnnotationCitation annotation={annotation}>Annotation 1</WiredGlyphAnnotationCitation>);
  fireEvent.click(screen.getByRole('link'));
  expect(scroll).toHaveBeenCalledWith({ block: 'center' });
  expect(document.querySelector('.glyph-annotation-reveal')).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(annotationRevealDuration);
  });
  expect(document.querySelector('.glyph-annotation-reveal')).toBeNull();
  node.hidden = true;
  fireEvent.click(screen.getByRole('link'));
  expect(document.querySelector('.glyph-annotation-reveal')).toBeNull();
  node.dataset.revision = '2';
  fireEvent.click(screen.getByRole('link'));
  expect(scroll).toHaveBeenCalledTimes(2);
});

it('positions previews above or below the citation and tolerates not-yet-mounted refs', () => {
  const { result } = renderHook(useGlyphAnnotationCitationState, { initialProps: annotation });
  act(() => {
    result.current.show();
  });
  expect(result.current.position).toEqual({ x: 8, y: 8 });
  act(() => {
    result.current.hide();
  });
  result.current.anchor.current = document.createElement('a');
  act(() => {
    result.current.show();
  });
  expect(result.current.position).toEqual({ x: 8, y: 8 });
  act(() => {
    result.current.hide();
  });
  const anchor = result.current.anchor.current;
  result.current.preview.current = document.createElement('div');
  vi.spyOn(result.current.preview.current, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 50));
  const bounds = vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 300, 20, 20));
  act(() => {
    result.current.show();
  });
  expect(result.current.position).toEqual({ x: 20, y: 244 });
  act(() => {
    result.current.hide();
  });
  bounds.mockReturnValue(new DOMRect(-100, 0, 20, 20));
  act(() => {
    result.current.show();
  });
  expect(result.current.position).toEqual({ x: 8, y: 26 });
});

it('refuses missing, changed, and out-of-range source text', () => {
  expect(annotationRange(annotation)).toBeUndefined();
  const node = source();
  expect(annotationRange(annotation)?.toString()).toBe('world');
  expect(annotationRange({ ...annotation, quote: 'changed' })).toBeUndefined();
  expect(annotationSourceRange(node, 50, 60)).toBeUndefined();
  expect(annotationSourceRange(node, 0, 60)).toBeUndefined();
  expect(annotationSourceRange(document.createElement('div'), 0, 0)).toBeUndefined();
});
