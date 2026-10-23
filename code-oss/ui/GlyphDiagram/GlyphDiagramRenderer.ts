import { tokens } from '#code-oss/ui/design-system/index.ts';
import { GlyphDiagramError } from './GlyphDiagramError.ts';
import { isRecord } from '#src/shared/validators/isRecord.js';
import { isGlyphDiagramLink, type GlyphDiagramRendering } from './GlyphDiagramTree.ts';

let rendererUrl = '/glyph-diagram.html';
let frame: HTMLIFrameElement | undefined;
let ready: Promise<void> | undefined;
const pending = new Map<
  string,
  { resolve: (rendering: GlyphDiagramRendering) => void; reject: (error: Error) => void }
>();
const colors = { bg: tokens.surface.canvas, fg: tokens.text.primary, muted: tokens.text.muted };

function readRendering(data: Record<string, unknown>): GlyphDiagramRendering | undefined {
  const { tree, links } = data;
  if (!isRecord(tree) || !Array.isArray(links)) return undefined;
  return { tree, links: links.filter(value => isGlyphDiagramLink(value)) };
}

/** The native bundle and Storybook serve the same isolated Mermaid renderer. */
export function configureGlyphDiagramRenderer(url: string): void {
  rendererUrl = url;
}

function start(): Promise<void> {
  if (ready) return ready;
  frame = document.createElement('iframe');
  frame.src = rendererUrl;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: '1000px',
    height: '1000px',
    visibility: 'hidden',
    border: '0',
  });
  ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new GlyphDiagramError('The diagram renderer did not load.'));
    }, 15000);
    window.addEventListener('message', event => {
      const data: unknown = event.data;
      if (event.source !== frame?.contentWindow || !isRecord(data) || data.channel !== 'glyph-diagram') return;
      if (data.ready === true) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (typeof data.id !== 'string') return;
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      const rendering = readRendering(data);
      if (rendering) job.resolve(rendering);
      else job.reject(new GlyphDiagramError('Unable to render this diagram.'));
    });
  });
  document.body.append(frame);
  return ready;
}

export async function renderGlyphDiagram(source: string, dark: boolean): Promise<GlyphDiagramRendering> {
  await start();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new GlyphDiagramError('Diagram rendering timed out.'));
    }, 15000);
    pending.set(id, {
      resolve: rendering => {
        clearTimeout(timeout);
        resolve(rendering);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    frame!.contentWindow!.postMessage({ channel: 'glyph-diagram', id, source, dark, colors }, '*');
  });
}
