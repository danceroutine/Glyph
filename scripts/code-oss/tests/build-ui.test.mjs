import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const modules = join(repositoryRoot, 'node_modules');

function packageTree(overrides = {}) {
  const manifest = (name, dependencies) => JSON.stringify({ name, ...(dependencies && { dependencies }) });
  return {
    files: {
      [join(modules, 'preact/LICENSE')]: 'preact license',
      [join(modules, 'lucide-preact/LICENSE')]: 'lucide license',
      [join(modules, 'mermaid/LICENSE')]: 'mermaid license',
      [join(modules, '@dagrejs/dagre/LICENSE')]: 'dagre license',
      [join(modules, 'marked/LICENSE')]: 'marked license',
      [join(modules, 'lowlight/package.json')]: manifest('lowlight', { devlop: '1' }),
      [join(modules, 'lowlight/LICENSE')]: 'lowlight license',
      [join(modules, 'devlop/package.json')]: manifest('devlop'),
      [join(modules, 'devlop/license')]: 'devlop lowercase license',
      [join(modules, 'prosemirror-model/package.json')]: manifest('prosemirror-model', { orderedmap: '2' }),
      [join(modules, 'prosemirror-model/LICENSE')]: 'model license',
      [join(modules, 'orderedmap/dist/package.json')]: manifest('nested-type-marker'),
      [join(modules, 'orderedmap/package.json')]: manifest('orderedmap'),
      [join(modules, 'orderedmap/LICENSE')]: 'orderedmap license',
      ...Object.fromEntries(
        [
          'prosemirror-state',
          'prosemirror-view',
          'prosemirror-history',
          'prosemirror-keymap',
          'prosemirror-commands',
        ].flatMap(name => [
          [join(modules, name, 'package.json'), manifest(name, { 'prosemirror-model': '1' })],
          [join(modules, name, 'LICENSE'), `${name} license`],
        ]),
      ),
      ...overrides.files,
    },
    entries: {
      devlop: join(modules, 'devlop/lib/index.js'),
      orderedmap: join(modules, 'orderedmap/dist/index.cjs'),
      ...overrides.entries,
    },
    unexported: ['devlop/package.json', 'orderedmap/package.json'],
  };
}

async function runBuild(tree) {
  const filesystem = {
    readFile: vi.fn(async path => {
      if (tree.files[path] === undefined) throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' });
      return tree.files[path];
    }),
  };
  const requireRoots = [];
  const module = {
    createRequire: vi.fn(from => {
      requireRoots.push(from);
      return {
        resolve: specifier => {
          if (specifier.endsWith('/package.json')) {
            const path = join(modules, specifier);
            if (tree.files[path] !== undefined && !tree.unexported.includes(specifier)) return path;
            throw new Error(`Package subpath ${specifier} is not exported`);
          }
          return tree.entries[specifier];
        },
      };
    }),
  };
  const esbuild = { build: vi.fn(async () => {}) };
  const diagram = { buildGlyphDiagram: vi.fn(async () => {}) };
  onTestFinished(() => {
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('node:module');
    vi.doUnmock('esbuild');
    vi.doUnmock('#scripts/code-oss/build-diagram.mjs');
  });
  vi.resetModules();
  vi.doMock('node:fs/promises', () => filesystem);
  vi.doMock('node:module', () => module);
  vi.doMock('esbuild', () => esbuild);
  vi.doMock('#scripts/code-oss/build-diagram.mjs', () => diagram);
  const { buildGlyphUi } = await import('#scripts/code-oss/build-ui.mjs');
  return { result: buildGlyphUi('/generated/src'), esbuild, diagram, requireRoots };
}

describe('buildGlyphUi', () => {
  it('builds the diagram frame beside the bundled workbench', async () => {
    const run = await runBuild(packageTree());
    await run.result;

    expect(run.diagram.buildGlyphDiagram).toHaveBeenCalledWith(
      '/generated/src/src/vs/workbench/contrib/glyph/browser/ui',
    );
  });

  it('bundles the workbench with every runtime license inlined into its banner', async () => {
    const run = await runBuild(packageTree());
    await run.result;

    const [options] = run.esbuild.build.mock.calls[0];
    expect({ ...options, banner: undefined }).toEqual({
      absWorkingDir: `${repositoryRoot}/`,
      entryPoints: ['code-oss/ui/mountGlyphWorkbench.tsx'],
      outfile: '/generated/src/src/vs/workbench/contrib/glyph/browser/ui/mountGlyphWorkbench.js',
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      tsconfig: 'code-oss/ui/tsconfig.json',
      sourcemap: true,
      legalComments: 'inline',
      banner: undefined,
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    expect(options.banner.js).toBe(
      [
        '/*! Preact\npreact license\n*/',
        '/*! Lucide\nlucide license\n*/',
        '/*! mermaid\nmermaid license\n*/',
        '/*! @dagrejs/dagre\ndagre license\n*/',
        '/*! marked\nmarked license\n*/',
        '/*! lowlight\nlowlight license\n*/',
        '/*! devlop\ndevlop lowercase license\n*/',
        '/*! prosemirror-model\nmodel license\n*/',
        '/*! orderedmap\norderedmap license\n*/',
        '/*! prosemirror-state\nprosemirror-state license\n*/',
        '/*! prosemirror-view\nprosemirror-view license\n*/',
        '/*! prosemirror-history\nprosemirror-history license\n*/',
        '/*! prosemirror-keymap\nprosemirror-keymap license\n*/',
        '/*! prosemirror-commands\nprosemirror-commands license\n*/',
      ].join('\n'),
    );
  });

  it('resolves transitive licenses from the package that declares each dependency', async () => {
    const run = await runBuild(packageTree());
    await run.result;

    expect(run.requireRoots).toEqual([
      join(repositoryRoot, 'package.json'),
      join(modules, 'lowlight', 'package.json'),
      join(modules, 'devlop', 'package.json'),
      join(modules, 'prosemirror-model', 'package.json'),
      join(modules, 'orderedmap', 'package.json'),
      ...[
        'prosemirror-state',
        'prosemirror-view',
        'prosemirror-history',
        'prosemirror-keymap',
        'prosemirror-commands',
      ].map(name => join(modules, name, 'package.json')),
    ]);
  });

  it('fails when a dependency has no package metadata above its entry point', async () => {
    const run = await runBuild(
      packageTree({
        files: { [join(modules, 'devlop/package.json')]: undefined },
        entries: { devlop: '/outside/devlop/index.js' },
      }),
    );

    await expect(run.result).rejects.toThrow('Missing package metadata for devlop');
  });
});
