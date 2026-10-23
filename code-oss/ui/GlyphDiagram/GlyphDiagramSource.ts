import { isGlyphDiagramLink, type GlyphDiagramLink } from './GlyphDiagramTree.ts';

export interface GlyphDiagramSource {
  readonly text: string;
  readonly links: readonly GlyphDiagramLink[];
  readonly native: boolean;
}

const nativeHeaders = [
  /^(?:graph|flowchart)\s+(?:td|tb|lr|bt|rl)\s*$/iu,
  /^statediagram(?:-v2)?\s*$/iu,
  /^sequencediagram\s*$/iu,
  /^classdiagram\s*$/iu,
  /^erdiagram\s*$/iu,
  /^xychart(?:-beta)?\b/iu,
];
const clickLink = /^\s*click\s+(\S+)\s+(?:href\s+)?"([^"]+)"/iu;

export function parseGlyphDiagramSource(source: string): GlyphDiagramSource {
  const links: GlyphDiagramLink[] = [];
  const content = source.split(/\r?\n/u).filter(line => !/^\s*%%/u.test(line));
  const header = content.find(line => line.trim() !== '')?.trim() ?? '';
  const flowchart = /^(?:graph|flowchart)\s/iu.test(header);
  const lines: string[] = [];
  for (const line of content) {
    const match = flowchart ? clickLink.exec(line) : null;
    if (match) {
      const link = { id: match[1], href: match[2] };
      if (isGlyphDiagramLink(link)) links.push(link);
      continue;
    }
    lines.push(line);
  }
  const text = lines.join('\n').trim();
  return { text, links, native: nativeHeaders.some(pattern => pattern.test(header)) };
}
