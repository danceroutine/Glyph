import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { annotationRange } from './GlyphAnnotationSource.ts';

export const annotationRevealDuration = 1600;
const previewGap = 6;
const viewportMargin = 8;
const closeDelay = 120;

export interface GlyphAnnotationHighlight {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function useGlyphAnnotationCitationState(annotation: GlyphAnnotation) {
  const previewId = useId();
  const anchor = useRef<HTMLAnchorElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: viewportMargin, y: viewportMargin });
  const [highlights, setHighlights] = useState<readonly GlyphAnnotationHighlight[]>([]);
  const cancelClose = () => {
    clearTimeout(closing.current);
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const hide = () => {
    cancelClose();
    setOpen(false);
  };
  const scheduleHide = () => {
    cancelClose();
    closing.current = setTimeout(() => {
      setOpen(false);
    }, closeDelay);
  };
  useEffect(() => cancelClose, []);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !preview.current) return;
    const link = anchor.current.getBoundingClientRect();
    const { width, height } = preview.current.getBoundingClientRect();
    const above = link.top - height - previewGap;
    setPosition({
      x: Math.max(viewportMargin, Math.min(innerWidth - width - viewportMargin, link.left)),
      y:
        above >= viewportMargin
          ? above
          : Math.max(viewportMargin, Math.min(innerHeight - height - viewportMargin, link.bottom + previewGap)),
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!event.composedPath().includes(preview.current!)) setOpen(false);
    };
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('scroll', close, true);
    };
  }, [open]);
  useEffect(() => {
    if (highlights.length === 0) return;
    const timer = setTimeout(() => {
      setHighlights([]);
    }, annotationRevealDuration);
    return () => {
      clearTimeout(timer);
    };
  }, [highlights]);
  return {
    annotation,
    previewId,
    anchor,
    preview,
    open,
    position,
    highlights,
    show,
    hide,
    scheduleHide,
    cancelClose,
    reveal: () => {
      hide();
      const range = annotationRange(annotation);
      if (!range) return;
      // annotationRange always starts in a text node of a mounted source.
      range.startContainer.parentElement!.scrollIntoView({ block: 'center' });
      setHighlights(
        [...range.getClientRects()]
          .filter(rect => rect.width > 0 && rect.height > 0)
          .map(({ left, top, width, height }) => ({ left, top, width, height })),
      );
    },
  };
}
export type GlyphAnnotationCitationState = ReturnType<typeof useGlyphAnnotationCitationState>;
