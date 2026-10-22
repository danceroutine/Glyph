import { GlyphDiagramError } from './GlyphDiagramError.ts';
import { isRecord } from '#src/shared/validators/isRecord.js';

let rendererUrl = '/glyph-diagram.html';
let frame: HTMLIFrameElement | undefined;
let ready: Promise<void> | undefined;
const pending = new Map<string, { resolve: (svg: string) => void; reject: (error: Error) => void }>();

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
      if (typeof data.svg === 'string') job.resolve(data.svg);
      else job.reject(new GlyphDiagramError('Unable to render this diagram.'));
    });
  });
  document.body.append(frame);
  return ready;
}

/** SVG stays an image: diagram markup never enters the privileged workbench DOM. */
export async function renderGlyphDiagram(source: string, dark: boolean): Promise<string> {
  await start();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new GlyphDiagramError('Diagram rendering timed out.'));
    }, 15000);
    pending.set(id, {
      resolve: svg => {
        clearTimeout(timeout);
        resolve(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      },
      reject: error => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    frame!.contentWindow!.postMessage({ channel: 'glyph-diagram', id, source, dark }, '*');
  });
}
