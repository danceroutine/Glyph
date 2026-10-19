import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildGlyphDiagram(destination) {
  await mkdir(destination, { recursive: true });
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('../..', import.meta.url)),
    entryPoints: ['code-oss/ui/GlyphDiagram/GlyphDiagram.frame.ts'],
    write: false,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
    legalComments: 'inline',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const hash = createHash('sha256').update(script).digest('base64');
  await writeFile(
    join(destination, 'glyph-diagram.html'),
    `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<body><script>${script}</script></body>`,
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildGlyphDiagram('.artifacts/diagram');
