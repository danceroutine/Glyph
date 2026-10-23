import mermaid from 'mermaid';
import { isRecord } from '#src/shared/validators/isRecord.js';
import { renderMermaidSVG, type RenderOptions } from 'beautiful-mermaid';
import { parseGlyphDiagramSource } from './GlyphDiagramSource.ts';
import { readGlyphDiagramTree } from './GlyphDiagramTree.ts';
import { assertGlyphDiagramComplexity } from './GlyphDiagramComplexity.ts';

// This script runs only in the sandboxed renderer document, without native APIs.
const colorNames = ['bg', 'fg', 'line', 'accent', 'muted', 'surface', 'border'] as const;

function readColors(value: unknown): RenderOptions {
  const colors: Record<string, string> = {};
  if (isRecord(value))
    for (const name of colorNames) {
      const color = value[name];
      if (typeof color === 'string') colors[name] = color;
    }
  return colors;
}

function renderNative(text: string, colors: RenderOptions): string | undefined {
  assertGlyphDiagramComplexity(text);
  try {
    return renderMermaidSVG(text, { ...colors, font: 'system-ui', transparent: true });
  } catch {
    return undefined;
  }
}

async function renderSvg(id: string, text: string, native: boolean, dark: boolean, colors: RenderOptions) {
  const svg = native ? renderNative(text, colors) : undefined;
  if (svg) return svg;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: 20000,
    maxEdges: 200,
    layout: 'dagre',
    look: 'classic',
    theme: dark ? 'dark' : 'default',
    htmlLabels: false,
    fontFamily: 'Arial, sans-serif',
    fontSize: 14,
    flowchart: { htmlLabels: false, useMaxWidth: true, curve: 'linear' },
  });
  return (await mermaid.render(`glyph-${id}`, text)).svg;
}

function parseSvg(svg: string): Element {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (!parsed.querySelector('parsererror')) return parsed.documentElement;
  const fallback = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
  if (!fallback) throw new Error('Diagram output is not an SVG document.');
  return fallback;
}

let queue = Promise.resolve();
window.addEventListener('message', event => {
  const data: unknown = event.data;
  if (event.source !== parent || !isRecord(data) || data.channel !== 'glyph-diagram') return;
  const { id, source, dark } = data;
  if (typeof id !== 'string' || typeof source !== 'string') return;
  queue = queue.then(async () => {
    try {
      if (source.length > 20000 || /%%\{|^---/m.test(source)) throw new Error('Unsupported diagram configuration.');
      const { text, links, native } = parseGlyphDiagramSource(source);
      const svg = await renderSvg(id, text, native, dark === true, readColors(data.colors));
      const tree = readGlyphDiagramTree(parseSvg(svg));
      parent.postMessage({ channel: 'glyph-diagram', id, tree, links }, '*');
    } catch {
      parent.postMessage({ channel: 'glyph-diagram', id, error: true }, '*');
    }
  });
});
parent.postMessage({ channel: 'glyph-diagram', ready: true }, '*');
