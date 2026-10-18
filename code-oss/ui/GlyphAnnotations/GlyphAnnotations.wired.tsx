import { createPortal } from 'preact/compat';
import type { GlyphComposerState } from '#src/desktop/workbench/GlyphComposerState.js';
import { GlyphAnnotations } from './GlyphAnnotations.presentational.tsx';
import { useGlyphAnnotationsState } from './useGlyphAnnotationsState.ts';
export function WiredGlyphAnnotations({
  composer,
  disabled,
}: {
  readonly composer: GlyphComposerState;
  readonly disabled: boolean;
}) {
  const state = useGlyphAnnotationsState(composer, disabled);
  return createPortal(<GlyphAnnotations {...state} />, document.querySelector('.monaco-workbench') ?? document.body);
}
