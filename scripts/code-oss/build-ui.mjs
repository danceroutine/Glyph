import { buildGlyphDiagram } from './build-diagram.mjs';
import { build } from 'esbuild';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';

const packageMetadataSchema = z.object({ name: z.string(), dependencies: z.record(z.string(), z.string()).optional() });

async function findPackageManifest(name, requireFrom) {
  for (const path of requireFrom.resolve.paths(name) ?? []) {
    const manifest = await realpath(join(path, name, 'package.json')).catch(() => undefined);
    if (manifest) return manifest;
  }
  throw new Error(`Missing package metadata for ${name}`);
}

/** Bundles JSX and Preact without adding their tooling or imports to upstream Code OSS. */
/** @param {string} sourceRoot */
export async function buildGlyphUi(sourceRoot) {
  await buildGlyphDiagram(join(sourceRoot, 'src/vs/workbench/contrib/glyph/browser/ui'));
  const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
  const preactLicense = await readFile(join(repositoryRoot, 'node_modules/preact/LICENSE'), 'utf8');
  const lucideLicense = await readFile(join(repositoryRoot, 'node_modules/lucide-preact/LICENSE'), 'utf8');
  /** @type {string[]} */
  const promptLicenses = [];
  for (const name of ['mermaid', '@dagrejs/dagre', 'marked']) {
    const license = await readFile(join(repositoryRoot, 'node_modules', name, 'LICENSE'), 'utf8');
    promptLicenses.push(`/*! ${name}\n${license}\n*/`);
  }
  /** @type {Set<string>} */
  const visited = new Set();
  /**
   * @param {string} name
   * @param {NodeJS.Require} requireFrom
   */
  async function readPromptLicense(name, requireFrom) {
    if (visited.has(name)) return;
    visited.add(name);
    let entry;
    try {
      entry = requireFrom.resolve(`${name}/package.json`);
    } catch {
      try {
        entry = requireFrom.resolve(name);
      } catch {
        entry = await findPackageManifest(name, requireFrom);
      }
    }
    let directory = dirname(entry);
    /** @type {z.infer<typeof packageMetadataSchema> | undefined} */
    let metadata;
    while (metadata === undefined) {
      try {
        const candidate = packageMetadataSchema.parse(
          JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')),
        );
        if (candidate.name === name) metadata = candidate;
      } catch {
        /* Entry points may live below the package root. */
      }
      if (metadata === undefined) {
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`Missing package metadata for ${name}`);
        directory = parent;
      }
    }
    const license = await readFile(join(directory, 'LICENSE'), 'utf8')
      .catch(() => readFile(join(directory, 'license'), 'utf8'))
      .catch(() => readFile(join(directory, 'LICENSE.md'), 'utf8'));
    promptLicenses.push(`/*! ${name}\n${license}\n*/`);
    const requireDependency = createRequire(join(directory, 'package.json'));
    for (const dependency of Object.keys(metadata.dependencies ?? {}))
      await readPromptLicense(dependency, requireDependency);
  }
  const requireRoot = createRequire(join(repositoryRoot, 'package.json'));
  for (const name of [
    'beautiful-mermaid',
    'lowlight',
    'prosemirror-model',
    'prosemirror-state',
    'prosemirror-view',
    'prosemirror-history',
    'prosemirror-keymap',
    'prosemirror-commands',
  ])
    await readPromptLicense(name, requireRoot);
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
    banner: { js: `/*! Preact\n${preactLicense}\n*/\n/*! Lucide\n${lucideLicense}\n*/\n${promptLicenses.join('\n')}` },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
}
