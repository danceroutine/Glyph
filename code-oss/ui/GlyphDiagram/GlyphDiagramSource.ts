import { isGlyphDiagramLink, type GlyphDiagramLink } from './GlyphDiagramTree.ts';

export interface GlyphDiagramSource {
  readonly text: string;
  readonly links: readonly GlyphDiagramLink[];
  readonly native: boolean;
}

const nativeHeaders = [
  /^(?:graph|flowchart)\s+(?:td|tb|lr|bt|rl)\s*$/i,
  /^statediagram(?:-v2)?\s*$/i,
  /^sequencediagram\s*$/i,
  /^classdiagram\s*$/i,
  /^erdiagram\s*$/i,
  /^xychart(?:-beta)?\b/i,
];
const clickLink = /^\s*click\s+(\S+)\s+(?:href\s+)?"([^"]+)"/i;

export function parseGlyphDiagramSource(source: string): GlyphDiagramSource {
  const links: GlyphDiagramLink[] = [];
  const lines: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*%%/.test(line)) continue;
    if (/^\s*click\s/i.test(line)) {
      const match = clickLink.exec(line);
      const link = match ? { id: match[1], href: match[2] } : undefined;
      if (isGlyphDiagramLink(link)) links.push(link);
      continue;
    }
    lines.push(line);
  }
  const text = lines.join('\n').trim();
  const header = text.split('\n')[0]?.trim() ?? '';
  return { text, links, native: nativeHeaders.some(pattern => pattern.test(header)) };
}
