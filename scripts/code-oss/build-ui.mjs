import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Bundles JSX and Preact without adding their tooling or imports to upstream Code OSS. */
export async function buildGlyphUi(sourceRoot) {
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const preactLicense = await readFile(join(repositoryRoot, 'node_modules/preact/LICENSE'), 'utf8');
  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: ['code-oss/ui/mountGlyphWorkbench.tsx'],
    outfile: join(sourceRoot, 'src/vs/workbench/contrib/glyph/browser/ui/mountGlyphWorkbench.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    tsconfig: 'code-oss/ui/tsconfig.json',
    sourcemap: true,
    legalComments: 'inline',
    banner: { js: `/*! Preact\n${preactLicense}\n*/` },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
}
