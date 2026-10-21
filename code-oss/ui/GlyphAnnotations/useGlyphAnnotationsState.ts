import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import type { GlyphAnnotationPosition, GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';

interface PositionedAnnotation extends GlyphAnnotationPosition {
  readonly annotation: GlyphAnnotation;
  readonly x: number;
  readonly y: number;
}
function samePosition(a: PositionedAnnotation | undefined, b: PositionedAnnotation | undefined): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.annotation === b.annotation &&
      a.x === b.x &&
      a.y === b.y &&
      a.minX === b.minX &&
      a.maxX === b.maxX &&
      a.container === b.container)
  );
}
function sourceRange(source: Element, from: number, to: number): Range | undefined {
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0,
    started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).data.length;
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
function findSource(annotation: GlyphAnnotation): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-glyph-source]')].find(
    node => node.dataset.glyphSource === annotation.sourceId && node.dataset.revision === annotation.revision,
  );
}
function position(annotation: GlyphAnnotation, selection = false): PositionedAnnotation | undefined {
  const source = findSource(annotation);
  const range = source && sourceRange(source, annotation.from, annotation.to);
  if (!range || range.toString() !== annotation.quote) return undefined;
  const rect = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).at(-1);
  if (!rect || rect.bottom < 0 || rect.top > innerHeight) return undefined;
  if (selection) {
    const selectionRect = range.getBoundingClientRect();
    return {
      annotation,
      x: selectionRect.left + selectionRect.width / 2,
      y: Math.max(8, selectionRect.top - 38),
      ...(annotation.kind === 'proposal' && source ? { minX: source.getBoundingClientRect().left } : {}),
    };
  }
  // The 30px speech bubble points from its lower-left corner to the last selected line.
  return {
    annotation,
    x: Math.max(0, Math.min(innerWidth - 30, rect.right - 3)),
    y: Math.max(0, rect.bottom - 28),
    ...(annotation.kind === 'proposal' && source ? { minX: source.getBoundingClientRect().left } : {}),
  };
}
export function useGlyphAnnotationsState({
  composer,
  disabled,
}: {
  readonly composer: GlyphComposerState;
  readonly disabled: boolean;
}) {
  const [snapshot, setSnapshot] = useState(composer.snapshot);
  const [candidate, setCandidate] = useState<PositionedAnnotation>();
  const [draft, setDraft] = useState<PositionedAnnotation>();
  const [comment, setComment] = useState('');
  const [markers, setMarkers] = useState<readonly PositionedAnnotation[]>([]);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<HTMLFormElement>(null);
  const [editorPosition, setEditorPosition] = useState({ x: 8, y: 8 });
  const annotations = snapshot.document.options?.annotations ?? [];
  useEffect(() => composer.subscribe(() => setSnapshot(composer.snapshot)), [composer]);
  useEffect(() => {
    if (snapshot.submitting) {
      setDraft(undefined);
      setCandidate(undefined);
    }
  }, [snapshot.submitting]);
  useLayoutEffect(() => {
    if (!draft || draft.container || !editor.current) return;
    const { width, height } = editor.current.getBoundingClientRect();
    const above = draft.y - height - 8;
    const minX = Math.max(8, draft.minX ?? 8);
    const maxX = Math.min(innerWidth - 8, draft.maxX ?? innerWidth - 8);
    setEditorPosition({
      x: Math.max(minX, Math.min(maxX - width, draft.x + 30 - width)),
      y: Math.max(8, Math.min(innerHeight - height - 8, above >= 8 ? above : draft.y + 36)),
    });
  }, [draft, comment]);
  useEffect(() => {
    if (!draft) return;
    textarea.current?.focus();
  }, [draft]);
  useEffect(() => {
    const update = () => {
      const next = annotations.flatMap(value => position(value) ?? []);
      setMarkers(current =>
        current.length === next.length && current.every((value, index) => samePosition(value, next[index]))
          ? current
          : next,
      );
      setCandidate(value => {
        const next = value ? position(value.annotation, true) : undefined;
        return samePosition(value, next) ? value : next;
      });
      setDraft(value => {
        const next = value ? (position(value.annotation) ?? value) : undefined;
        return samePosition(value, next) ? value : next;
      });
    };
    update();
    document.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    const observer = new MutationObserver(update);
    const resize = new ResizeObserver(update);
    for (const source of document.querySelectorAll('[data-glyph-source]')) {
      observer.observe(source, { childList: true, characterData: true, subtree: true });
      resize.observe(source);
    }
    return () => {
      document.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      observer.disconnect();
      resize.disconnect();
    };
  }, [snapshot.document]);
  useEffect(() => {
    const annotation = snapshot.annotationDraft ?? annotations.find(value => value.id === snapshot.editingAnnotation);
    if (!annotation) {
      if (draft && annotations.some(value => value.id === draft.annotation.id) === false && draft.annotation.comment)
        setDraft(undefined);
      return;
    }
    findSource(annotation)?.scrollIntoView({ block: 'center' });
    let cancelled = false;
    void composer
      .revealAnnotation(annotation)
      .catch(() => {})
      .then(nativePosition => {
        if (cancelled) return;
        setDraft(position(annotation) ?? { annotation, ...(nativePosition ?? { x: innerWidth - 380, y: 100 }) });
        setComment(annotation.comment);
        setCandidate(undefined);
        textarea.current?.focus();
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.editingAnnotation, snapshot.annotationDraft]);
  useEffect(() => {
    const capture = () => {
      if (disabled || draft) return;
      const selection = document.getSelection();
      if (!selection?.rangeCount || selection.isCollapsed) {
        setCandidate(undefined);
        return;
      }
      const range = selection.getRangeAt(0);
      const parent =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement;
      const source = parent?.closest<HTMLElement>('[data-glyph-source]');
      if (!source || !source.contains(range.endContainer)) {
        setCandidate(undefined);
        return;
      }
      const quote = range.toString();
      if (!quote.trim() || quote.length > 50000) return;
      const before = range.cloneRange();
      before.selectNodeContents(source);
      before.setEnd(range.startContainer, range.startOffset);
      const from = before.toString().length;
      const annotation: GlyphAnnotation = {
        id: crypto.randomUUID(),
        order: Math.max(0, ...annotations.map(value => value.order)) + 1,
        kind: source.dataset.kind as GlyphAnnotation['kind'],
        sourceId: source.dataset.glyphSource!,
        revision: source.dataset.revision!,
        label: source.dataset.label ?? 'Selected text',
        from,
        to: from + quote.length,
        quote,
        comment: '',
      };
      setCandidate(position(annotation, true));
    };
    document.addEventListener('mouseup', capture);
    document.addEventListener('keyup', capture);
    return () => {
      document.removeEventListener('mouseup', capture);
      document.removeEventListener('keyup', capture);
    };
  }, [draft, disabled, snapshot.document]);
  const close = () => {
    setDraft(undefined);
    setCandidate(undefined);
    composer.editAnnotation(undefined);
  };
  return {
    annotations,
    candidate,
    draft,
    comment,
    markers,
    textarea,
    editor,
    editorPosition,
    disabled,
    setComment,
    open: () => {
      if (candidate) {
        setDraft(candidate);
        setComment('');
        setCandidate(undefined);
      }
    },
    edit: (id: string) => composer.editAnnotation(id),
    remove: (id: string) => composer.removeAnnotation(id),
    close,
    submit: () => {
      if (draft && comment.trim() && !disabled) {
        composer.saveAnnotation({ ...draft.annotation, comment: comment.trim() });
        close();
      }
    },
  };
}
export type GlyphAnnotationsState = ReturnType<typeof useGlyphAnnotationsState>;
