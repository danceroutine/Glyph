import { describe, expect, it } from 'vitest';
import {
  createGlyphDiagramElement,
  isGlyphDiagramLink,
  readGlyphDiagramTree,
  safeGlyphDiagramCss,
} from '#code-oss/ui/GlyphDiagram/GlyphDiagramTree.ts';

const element = (tag = 'svg', children: readonly unknown[] = [], attributes: Record<string, unknown> = {}) => ({
  tag,
  attributes,
  children,
});
const xml = (source: string) => new DOMParser().parseFromString(source, 'image/svg+xml').documentElement;

describe('diagram output boundary', () => {
  it('retains inert SVG text, geometry and local references while dropping executable and remote content', () => {
    const source = xml(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="bad()"><!-- ignored --><script>bad()</script><text><![CDATA[<safe>]]></text><style>@import "remote"; rect { fill: url(#local) }</style><rect width="10" fill="url(https://example.com)" stroke="url(#local)" style="background: url(remote)" opacity="expression(bad())" /><a href="bad">unsafe</a></svg>',
    );
    source.append(document.createTextNode(''));
    const tree = readGlyphDiagramTree(source);
    const result = createGlyphDiagramElement(document, tree);
    expect(result.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(result.hasAttribute('onload')).toBe(false);
    expect(result.querySelector('script, a')).toBeNull();
    expect(result.querySelector('text')?.textContent).toBe('<safe>');
    expect(result.querySelector('style')?.textContent).toContain('url(#local)');
    expect(result.querySelector('style')?.textContent).not.toContain('@import');
    const rect = result.querySelector('rect')!;
    expect(rect.getAttribute('width')).toBe('10');
    expect(rect.hasAttribute('fill')).toBe(false);
    expect(rect.hasAttribute('opacity')).toBe(false);
    expect(rect.getAttribute('stroke')).toBe('url(#local)');
    expect(rect.getAttribute('style')).toBe('background: none');
  });

  it('validates untrusted tree members and requires an SVG root', () => {
    const result = createGlyphDiagramElement(
      document,
      element(
        'svg',
        [
          null,
          false,
          { tag: 42 },
          element('script'),
          { tag: 'rect' },
          { tag: 'circle', attributes: 3, children: 'not an array' },
          element('text', ['hello']),
        ],
        { width: 10, height: '20', onload: 'x', fill: 'javascript:bad' },
      ),
    );
    expect(result.outerHTML).toBe('<svg height="20"><rect></rect><circle></circle><text>hello</text></svg>');
    for (const root of [null, 'text', element('rect'), element('script')])
      expect(() => createGlyphDiagramElement(document, root)).toThrow('not an SVG');
    expect(() => readGlyphDiagramTree(document.createElement('div'))).toThrow('not an SVG');
  });

  it('bounds both tree depth and element count on either side of the frame', () => {
    let deep: unknown = element('g');
    for (let i = 0; i < 66; i++) deep = element('g', [deep]);
    expect(() => createGlyphDiagramElement(document, element('svg', [deep]))).toThrow('too large');
    expect(() =>
      createGlyphDiagramElement(
        document,
        element(
          'svg',
          Array.from({ length: 20000 }, () => element('rect')),
        ),
      ),
    ).toThrow('too large');
    expect(() => readGlyphDiagramTree(xml('<svg>' + '<g>'.repeat(66) + '</g>'.repeat(66) + '</svg>'))).toThrow(
      'too large',
    );
    expect(() => readGlyphDiagramTree(xml('<svg>' + '<rect/>'.repeat(20000) + '</svg>'))).toThrow('too large');
  });

  it('removes remote CSS references and imports', () => {
    expect(
      safeGlyphDiagramCss('@import url(remote); rect { fill: url(#local); stroke: url("https://example.com") }'),
    ).toBe(' rect { fill: url(#local); stroke: none }');
  });
});

it.each([
  null,
  false,
  {},
  { id: 2, href: 'a' },
  { id: '', href: 'a' },
  { id: 'a', href: 1 },
  { id: 'a', href: '' },
  { id: 'a', href: 'x'.repeat(2049) },
  { id: 'a', href: 'javascript:alert(1)' },
])('rejects an unsafe diagram link: %j', value => {
  expect(isGlyphDiagramLink(value)).toBe(false);
});
it.each(['https://example.com', 'http://example.com', 'src/app.ts'])('accepts a validated diagram link: %s', href => {
  expect(isGlyphDiagramLink({ id: 'a', href })).toBe(true);
});
