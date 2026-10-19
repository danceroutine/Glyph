import mermaid from 'mermaid';

// This script runs only in the sandboxed renderer document, without native APIs.
let queue = Promise.resolve();
window.addEventListener('message', event => {
  if (event.source !== parent || event.data?.channel !== 'glyph-diagram') return;
  const { id, source, dark } = event.data;
  if (typeof id !== 'string' || typeof source !== 'string') return;
  queue = queue.then(async () => {
    try {
      if (source.length > 20000 || /%%\{|^---/m.test(source)) throw new Error('Unsupported diagram configuration.');
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
      const { svg } = await mermaid.render(`glyph-${id}`, source);
      parent.postMessage({ channel: 'glyph-diagram', id, svg }, '*');
    } catch {
      parent.postMessage({ channel: 'glyph-diagram', id, error: true }, '*');
    }
  });
});
parent.postMessage({ channel: 'glyph-diagram', ready: true }, '*');
