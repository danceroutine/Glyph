import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';

export function annotationSourceRange(source: Element, from: number, to: number): Range | undefined {
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0,
    started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (!started && from <= offset + length) {
      range.setStart(node, Math.max(0, from - offset));
      started = true;
    }
    if (started && to <= offset + length) {
      range.setEnd(node, to - offset);
      return range;
    }
    offset += length;
  }
  return undefined;
}

export function findAnnotationSource(annotation: GlyphAnnotation): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-glyph-source]')].find(
    node => node.dataset.glyphSource === annotation.sourceId && node.dataset.revision === annotation.revision,
  );
}

export function annotationRange(annotation: GlyphAnnotation): Range | undefined {
  const source = findAnnotationSource(annotation);
  const range = source && annotationSourceRange(source, annotation.from, annotation.to);
  return range?.toString() === annotation.quote ? range : undefined;
}

/** Center the range, not a potentially viewport-sized paragraph containing it. */
export function scrollAnnotationRange(range: Range): void {
  for (let ancestor = range.startContainer.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (!['auto', 'scroll'].includes(getComputedStyle(ancestor).overflowY)) continue;
    ancestor.scrollBy({
      top: range.getBoundingClientRect().top - ancestor.getBoundingClientRect().top - ancestor.clientHeight / 2,
      behavior: 'instant',
    });
  }
  window.scrollBy({ top: range.getBoundingClientRect().top - innerHeight / 2, behavior: 'instant' });
}
