import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { tokens } from '#code-oss/ui/design-system/index.ts';
import { renderGlyphDiagram } from './GlyphDiagramRenderer.ts';
import { createGlyphDiagramElement, type GlyphDiagramRendering } from './GlyphDiagramTree.ts';

const shadowStyles = `
:host { display: block; }
svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
:host([data-expanded]) { width: 100%; height: 100%; }
:host([data-expanded]) svg { width: 100%; height: 100%; max-width: none !important; }
text { font-family: ${tokens.font.family.body}; }
[role="link"] { cursor: pointer; }
[role="link"]:focus { outline: none; }
[role="link"]:focus-visible { outline: ${tokens.focus.ring}; outline-offset: 2px; }
`;

export function useGlyphDiagramState(source: string, openLink?: (href: string) => void) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const navigate = useRef(openLink);
  navigate.current = openLink;
  const [rendering, setRendering] = useState<GlyphDiagramRendering>();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    setRendering(undefined);
    const light = !!root.current?.closest('.vs, .hc-light, [data-theme="light"]');
    void renderGlyphDiagram(source, !light)
      .then(value => {
        if (!cancelled) setRendering(value);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);
  useLayoutEffect(() => {
    const host = canvas.current;
    if (!host || !rendering) return;
    let svg: SVGSVGElement;
    try {
      svg = createGlyphDiagramElement(document, rendering.tree);
    } catch {
      setError(true);
      return;
    }
    const style = document.createElement('style');
    style.textContent = shadowStyles;
    (host.shadowRoot ?? host.attachShadow({ mode: 'open' })).replaceChildren(svg, style);
    if (!navigate.current) return;
    const nodes = new Map<string, Element>();
    for (const node of svg.querySelectorAll('[data-id]')) nodes.set(node.getAttribute('data-id')!, node);
    for (const { id, href } of rendering.links) {
      const node = nodes.get(id);
      if (!node) continue;
      const open = () => navigate.current?.(href);
      node.setAttribute('role', 'link');
      node.setAttribute('tabindex', '0');
      node.setAttribute('aria-label', node.getAttribute('data-label') || id);
      node.addEventListener('click', open);
      node.addEventListener('keydown', event => {
        if ((event as KeyboardEvent).key !== 'Enter') return;
        event.preventDefault();
        open();
      });
    }
  }, [rendering]);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setExpanded(false);
        root.current?.querySelector('button')?.focus();
      }
    };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
    };
  }, [expanded]);
  return {
    root,
    canvas,
    rendered: !!rendering,
    interactive: !!rendering?.links.length && !!openLink,
    error,
    source,
    expanded,
    toggle: () => setExpanded(value => !value),
  };
}
export type GlyphDiagramState = ReturnType<typeof useGlyphDiagramState>;
