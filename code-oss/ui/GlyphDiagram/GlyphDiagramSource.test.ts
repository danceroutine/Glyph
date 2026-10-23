import { describe, expect, it } from 'vitest';
import { parseGlyphDiagramSource } from '#code-oss/ui/GlyphDiagram/GlyphDiagramSource.ts';

describe(parseGlyphDiagramSource, () => {
  it('keeps Gantt tasks whose names start with Click', () => {
    const source = 'gantt\n  dateFormat YYYY-MM-DD\n  Click button :a1, 2026-10-01, 1d';
    expect(parseGlyphDiagramSource(source)).toEqual({ text: source, links: [], native: false });
  });
  it('extracts only recognized flowchart click directives, retaining other Click text', () => {
    const source = 'flowchart LR\n  A[Docs] --> B[Source]\n  click A "https://example.com"\n  click B href "src/app.ts"\n  click C "javascript:alert(1)"\n  Click button';
    expect(parseGlyphDiagramSource(source)).toEqual({
      text: 'flowchart LR\n  A[Docs] --> B[Source]\n  Click button',
      links: [{ id: 'A', href: 'https://example.com' }, { id: 'B', href: 'src/app.ts' }], native: true,
    });
  });
  it('ignores comments and handles empty and unsupported headers', () => {
    expect(parseGlyphDiagramSource('%% note\n\n')).toEqual({ text: '', links: [], native: false });
    expect(parseGlyphDiagramSource('pie\n title Things').native).toBe(false);
    expect(parseGlyphDiagramSource('stateDiagram-v2\r\n A --> B').native).toBe(true);
  });
});
