export interface GlyphDiagramElement {
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly GlyphDiagramNode[];
}

export type GlyphDiagramNode = GlyphDiagramElement | string;

export interface GlyphDiagramLink {
  readonly id: string;
  readonly href: string;
}

export interface GlyphDiagramRendering {
  readonly tree: GlyphDiagramElement;
  readonly links: readonly GlyphDiagramLink[];
}

const svgNamespace = 'http://www.w3.org/2000/svg';
const maximumDepth = 64;
const maximumElements = 20000;

const allowedTags = new Set([
  'svg',
  'g',
  'defs',
  'style',
  'marker',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComposite',
  'feDropShadow',
  'feFlood',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feOffset',
]);

const allowedAttributes = new Set([
  'id',
  'class',
  'style',
  'viewBox',
  'preserveAspectRatio',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'fr',
  'd',
  'points',
  'pathLength',
  'transform',
  'opacity',
  'display',
  'visibility',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'vector-effect',
  'paint-order',
  'shape-rendering',
  'text-rendering',
  'clip-path',
  'clip-rule',
  'clipPathUnits',
  'mask',
  'maskUnits',
  'filter',
  'filterUnits',
  'marker-start',
  'marker-mid',
  'marker-end',
  'markerWidth',
  'markerHeight',
  'markerUnits',
  'refX',
  'refY',
  'orient',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
  'spreadMethod',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'letter-spacing',
  'text-anchor',
  'text-decoration',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'writing-mode',
  'textLength',
  'lengthAdjust',
  'rotate',
  'dx',
  'dy',
  'stdDeviation',
  'in',
  'in2',
  'result',
  'operator',
  'mode',
  'values',
  'flood-color',
  'flood-opacity',
  'data-id',
  'data-label',
]);

export function safeGlyphDiagramCss(css: string): string {
  return css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(['"]?)\s*(?!#)[^)]*\)/gi, 'none');
}

function safeAttribute(name: string, value: string): string | undefined {
  if (!allowedAttributes.has(name) || /javascript:|expression\(/i.test(value)) return undefined;
  if (name === 'style') return safeGlyphDiagramCss(value);
  for (const match of value.matchAll(/url\(\s*(['"]?)\s*([^)'"]*)/gi)) if (!match[2]?.startsWith('#')) return undefined;
  return value;
}

export function isGlyphDiagramLink(value: unknown): value is GlyphDiagramLink {
  if (!value || typeof value !== 'object') return false;
  const { id, href } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof href === 'string' &&
    id.length > 0 &&
    href.length > 0 &&
    href.length <= 2048 &&
    (/^https?:\/\//i.test(href) || !/^[a-z][a-z\d+.-]*:/i.test(href))
  );
}

export function readGlyphDiagramTree(root: Element): GlyphDiagramElement {
  if (root.localName !== 'svg') throw new Error('Diagram output is not an SVG document.');
  let elements = 0;
  const read = (element: Element, depth: number): GlyphDiagramElement => {
    if (++elements > maximumElements || depth > maximumDepth) throw new Error('Diagram output is too large.');
    const attributes: Record<string, string> = {};
    for (const attribute of element.attributes) {
      const value = safeAttribute(attribute.name, attribute.value);
      if (value !== undefined) attributes[attribute.name] = value;
    }
    const children: GlyphDiagramNode[] = [];
    for (const child of element.childNodes) {
      if (child.nodeType === child.TEXT_NODE || child.nodeType === child.CDATA_SECTION_NODE) {
        const text = child.textContent ?? '';
        if (text) children.push(element.localName === 'style' ? safeGlyphDiagramCss(text) : text);
      } else if (child.nodeType === child.ELEMENT_NODE && allowedTags.has((child as Element).localName)) {
        children.push(read(child as Element, depth + 1));
      }
    }
    return { tag: element.localName, attributes, children };
  };
  return read(root, 0);
}

export function createGlyphDiagramElement(document: Document, tree: unknown): SVGSVGElement {
  let elements = 0;
  const create = (node: unknown, depth: number, parentTag: string): Node | undefined => {
    if (typeof node === 'string')
      return document.createTextNode(parentTag === 'style' ? safeGlyphDiagramCss(node) : node);
    if (!node || typeof node !== 'object') return undefined;
    const { tag, attributes, children } = node as Record<string, unknown>;
    if (typeof tag !== 'string' || !allowedTags.has(tag)) return undefined;
    if (++elements > maximumElements || depth > maximumDepth) throw new Error('Diagram output is too large.');
    const element = document.createElementNS(svgNamespace, tag);
    if (attributes && typeof attributes === 'object')
      for (const [name, value] of Object.entries(attributes)) {
        const safe = typeof value === 'string' ? safeAttribute(name, value) : undefined;
        if (safe !== undefined) element.setAttribute(name, safe);
      }
    if (Array.isArray(children))
      for (const child of children) {
        const created = create(child, depth + 1, tag);
        if (created) element.append(created);
      }
    return element;
  };
  const root = create(tree, 0, '');
  if (!(root instanceof SVGSVGElement)) throw new Error('Diagram output is not an SVG document.');
  return root;
}
