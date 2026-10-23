import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { css, tokens } from '#code-oss/ui/design-system/index.ts';
import { GlyphAnnotationDetails } from './GlyphAnnotations.presentational.tsx';
import { annotationRevealDuration, type GlyphAnnotationCitationState } from './useGlyphAnnotationCitationState.ts';
const styles = {
  preview: css({
    position: 'fixed',
    zIndex: 1001,
    boxSizing: 'border-box',
    width: 380,
    maxWidth: `calc(100vw - ${tokens.space.lg * 2}px)`,
    maxHeight: 350,
    overflow: 'auto',
    padding: tokens.space.lg,
    border: tokens.border.default,
    borderRadius: tokens.card.radius,
    background: tokens.dropdown.background,
    color: tokens.text.primary,
    fontFamily: tokens.font.family.body,
    fontSize: tokens.font.size.body,
  }),
  highlight: css({
    position: 'fixed',
    zIndex: 1000,
    pointerEvents: 'none',
    borderRadius: tokens.badge.radius,
    background: `color-mix(in srgb, ${tokens.focus.color} 35%, transparent)`,
    animation: `glyph-annotation-reveal ${annotationRevealDuration}ms ease-out forwards`,
    '@keyframes glyph-annotation-reveal': { '0%, 40%': { opacity: 1 }, '100%': { opacity: 0 } },
    '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
  }),
};
export function GlyphAnnotationCitation({
  state,
  layer,
  children,
}: {
  readonly state: GlyphAnnotationCitationState;
  readonly layer: Element;
  readonly children: ComponentChildren;
}) {
  return (
    <>
      <a
        href="#"
        ref={state.anchor}
        class="glyph-annotation-citation"
        aria-describedby={state.open ? state.previewId : undefined}
        onMouseEnter={state.show}
        onMouseLeave={state.scheduleHide}
        onFocus={state.show}
        onBlur={state.hide}
        onKeyDown={event => {
          if (event.key !== 'Escape' || !state.open) return;
          event.preventDefault();
          event.stopPropagation();
          state.hide();
        }}
        onClick={event => {
          event.preventDefault();
          state.reveal();
        }}
      >
        {children}
      </a>
      {state.open &&
        createPortal(
          <div
            id={state.previewId}
            role="tooltip"
            ref={state.preview}
            class={`glyph-annotation-preview ${styles.preview}`}
            style={{ left: `${state.position.x}px`, top: `${state.position.y}px` }}
            onMouseEnter={state.cancelClose}
            onMouseLeave={state.scheduleHide}
          >
            <GlyphAnnotationDetails annotation={state.annotation} />
          </div>,
          layer,
        )}
      {state.highlights.length > 0 &&
        createPortal(
          <div aria-hidden="true">
            {state.highlights.map(({ left, top, width, height }) => (
              <div
                key={`${left}:${top}`}
                class={`glyph-annotation-reveal ${styles.highlight}`}
                style={{ left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` }}
              />
            ))}
          </div>,
          layer,
        )}
    </>
  );
}
