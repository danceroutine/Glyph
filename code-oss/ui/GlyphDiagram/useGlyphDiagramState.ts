import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { renderGlyphDiagram } from './GlyphDiagramRenderer.ts';

export function useGlyphDiagramState({ source }: { readonly source: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [diagram, setDiagram] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setError(false);
    setDiagram(undefined);
    const light = !!root.current?.closest('.vs, .hc-light, [data-theme="light"]');
    void renderGlyphDiagram(source, !light)
      .then(value => {
        if (!cancelled) setDiagram(value);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);
  useLayoutEffect(() => {
    if (!expanded) return undefined;
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
    diagram,
    error,
    source,
    expanded,
    toggle: () => {
      setExpanded(value => !value);
    },
  };
}
export type GlyphDiagramState = ReturnType<typeof useGlyphDiagramState>;
