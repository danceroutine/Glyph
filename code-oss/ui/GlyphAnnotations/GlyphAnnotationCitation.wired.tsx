import type { ComponentChildren } from 'preact';
import type { GlyphAnnotation } from '#src/desktop/protocol/events/GlyphAnnotation.js';
import { GlyphAnnotationCitation } from './GlyphAnnotationCitation.presentational.tsx';
import { useGlyphAnnotationCitationState } from './useGlyphAnnotationCitationState.ts';
export function WiredGlyphAnnotationCitation({
  annotation,
  children,
}: {
  readonly annotation: GlyphAnnotation;
  readonly children: ComponentChildren;
}) {
  const state = useGlyphAnnotationCitationState(annotation);
  return (
    <GlyphAnnotationCitation state={state} layer={document.querySelector('.monaco-workbench') ?? document.body}>
      {children}
    </GlyphAnnotationCitation>
  );
}
