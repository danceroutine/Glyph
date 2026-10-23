import { build, transform } from 'esbuild';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  convertProcessCoverage,
  findIncompleteFiles,
  mergeOntoBaseline,
  readGeneratedSource,
  toFilePath,
  toRepositorySource,
} from '#scripts/coverage/v8-coverage.mjs';

async function temporaryDirectory() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'glyph-v8-coverage-')));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeTree(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
}

/** @param {string} code @param {Record<string, number>} counts */
function blockCoverage(code, counts) {
  return [
    { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] },
    ...Object.entries(counts).map(([name, count]) => {
      const startOffset = code.indexOf(`function ${name}`);
      return {
        functionName: name,
        isBlockCoverage: true,
        ranges: [{ startOffset, endOffset: code.indexOf('}', startOffset) + 1, count }],
      };
    }),
  ];
}

describe(toFilePath, () => {
  it('decodes desktop resource URLs to absolute paths', () => {
    expect(toFilePath('vscode-file://vscode-app/Users/me/My%20Repo/out/main.js')).toBe('/Users/me/My Repo/out/main.js');
  });

  it('converts file URLs to paths', () => {
    expect(toFilePath('file:///Users/me/repo/out/main.js')).toBe('/Users/me/repo/out/main.js');
  });

  it('leaves other schemes unresolved', () => {
    expect(toFilePath('node:internal/main')).toBeUndefined();
  });
});

describe(toRepositorySource, () => {
  it('keeps paths outside the generated Code OSS tree', () => {
    expect(toRepositorySource('/repo/src/chat/AgentMode.ts', '/repo')).toBe('/repo/src/chat/AgentMode.ts');
  });

  it('returns copied chat and review contracts to their source modules', () => {
    expect(toRepositorySource('/repo/.code-oss/src/src/vs/platform/glyph/chat/AgentMode.ts', '/repo')).toBe(
      '/repo/src/chat/AgentMode.ts',
    );
    expect(toRepositorySource('/repo/.code-oss/src/src/vs/platform/glyph/reviewing/AgentReview.ts', '/repo')).toBe(
      '/repo/src/reviewing/AgentReview.ts',
    );
  });

  it('drops reprinted protocol and workbench copies', () => {
    expect(toRepositorySource('/repo/.code-oss/src/src/vs/platform/glyph/shared/validators/isRecord.ts', '/repo')).toBe(
      '/repo/src/shared/validators/isRecord.ts',
    );
    expect(
      toRepositorySource('/repo/.code-oss/src/src/vs/platform/glyph/common/protocol/GlyphHostEvent.ts', '/repo'),
    ).toBeUndefined();
  });

  it('attributes other generated modules to the overlay', () => {
    expect(
      toRepositorySource('/repo/.code-oss/src/src/vs/workbench/contrib/glyph/browser/GlyphViewPane.ts', '/repo'),
    ).toBe('/repo/code-oss/overlay/src/vs/workbench/contrib/glyph/browser/GlyphViewPane.ts');
  });
});

describe(readGeneratedSource, () => {
  it.each(['//# sourceMappingURL= ', '//# sourceMappingURL=map.json\nconsole.log(1);'])(
    'ignores missing or nonterminal references: %s',
    async code => {
      const directory = await temporaryDirectory();
      await writeTree(directory, { 'invalid.js': code });
      expect(await readGeneratedSource(join(directory, 'invalid.js'))).toEqual({ code, map: undefined });
    },
  );
  it('returns code without a map when no source map is referenced', async () => {
    const directory = await temporaryDirectory();
    await writeTree(directory, { 'plain.js': 'console.log(1);\n' });

    expect(await readGeneratedSource(join(directory, 'plain.js'))).toEqual({
      code: 'console.log(1);\n',
      map: undefined,
    });
  });

  it('decodes inline base64 source maps', async () => {
    const directory = await temporaryDirectory();
    const map = { version: 3, sources: ['input.ts'], names: [], mappings: 'AAAA' };
    const code = `console.log('Ā');\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
    await writeTree(directory, { 'inline.js': code });

    expect(await readGeneratedSource(join(directory, 'inline.js'))).toEqual({ code, map });
  });

  it('reads external source maps relative to the generated file', async () => {
    const directory = await temporaryDirectory();
    const map = { version: 3, sources: ['../input.ts'], names: [], mappings: 'AAAA' };
    const code = 'console.log(1);\n//# sourceMappingURL=maps/external.js.map';
    await writeTree(directory, { 'external.js': code, 'maps/external.js.map': JSON.stringify(map) });

    expect(await readGeneratedSource(join(directory, 'external.js'))).toEqual({ code, map });
  });

  it('reads large inline maps without exhausting the regular-expression stack', async () => {
    const directory = await temporaryDirectory();
    const map = {
      version: 3,
      sources: ['input.ts'],
      names: [],
      mappings: 'AAAA',
      sourcesContent: ['x'.repeat(20_000_000)],
    };
    const code = `console.log('Ā');\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}\n`;
    await writeTree(directory, { 'large.js': code });
    expect((await readGeneratedSource(join(directory, 'large.js'))).map).toEqual(map);
  });
});

describe(convertProcessCoverage, () => {
  it('maps generated execution counts back onto tracked source files', async () => {
    const repositoryRoot = await temporaryDirectory();
    const source = join(repositoryRoot, 'src', 'example.ts');
    const text =
      'export function used(value: number) {\n  return value + 1;\n}\nexport function unused() {\n  return 0;\n}\n';
    const { code } = await transform(text, { loader: 'ts', format: 'esm', sourcemap: 'inline', sourcefile: source });
    await writeTree(repositoryRoot, { 'src/example.ts': text, 'out/example.js': code });
    const url = pathToFileURL(join(repositoryRoot, 'out', 'example.js')).href;

    const converted = await convertProcessCoverage(
      [
        { result: [{ scriptId: '1', url, functions: blockCoverage(code, { used: 2, unused: 0 }) }] },
        { result: [{ scriptId: '7', url, functions: blockCoverage(code, { used: 1, unused: 0 }) }] },
      ],
      { repositoryRoot, files: new Set([source]) },
    );

    expect(Object.keys(converted)).toEqual([source]);
    expect(converted[source]).toHaveLength(1);
    expect(converted[source][0].f).toEqual({ 0: 3, 1: 0 });
    expect(converted[source][0].s).toEqual({ 0: 3, 1: 0 });
    expect(converted[source][0].fnMap[1].loc.start).toEqual({ line: 4, column: 25 });
  });

  it('resolves external maps through their source root and the generated Code OSS tree', async () => {
    const repositoryRoot = await temporaryDirectory();
    const overlay = join(repositoryRoot, 'code-oss/overlay/src/vs/workbench/contrib/glyph/browser/Pane.ts');
    const text = 'export function open() {\n  return 1;\n}\n';
    const { code, map } = await transform(text, {
      loader: 'ts',
      format: 'esm',
      sourcemap: 'external',
      sourcefile: 'Pane.ts',
    });
    await writeTree(repositoryRoot, {
      '.code-oss/src/out/vs/workbench/contrib/glyph/browser/Pane.js': `${code}//# sourceMappingURL=Pane.js.map\n`,
      '.code-oss/src/out/vs/workbench/contrib/glyph/browser/Pane.js.map': JSON.stringify({
        ...JSON.parse(map),
        sourceRoot: '../../../../../../src/vs/workbench/contrib/glyph/browser',
      }),
    });
    const url = `vscode-file://vscode-app${join(repositoryRoot, '.code-oss/src/out/vs/workbench/contrib/glyph/browser/Pane.js')}`;

    const converted = await convertProcessCoverage(
      [{ result: [{ scriptId: '1', url, functions: blockCoverage(code, { open: 1 }) }] }],
      { repositoryRoot, files: new Set([overlay]) },
    );

    expect(Object.keys(converted)).toEqual([overlay]);
    expect(converted[overlay][0].f).toEqual({ 0: 1 });
  });

  it('keeps only tracked sources from a bundle that also maps untracked and reprinted modules', async () => {
    const repositoryRoot = await temporaryDirectory();
    const tracked = join(repositoryRoot, 'code-oss/ui/Entry.ts');
    await writeTree(repositoryRoot, {
      'code-oss/ui/Entry.ts':
        "import { helper } from '../../node_modules/helper/index.ts';\nimport { reprinted } from '../../.code-oss/src/src/vs/platform/glyph/common/protocol/Reprinted.ts';\nexport function entry() {\n  return helper() + reprinted();\n}\n",
      'node_modules/helper/index.ts': 'export function helper() {\n  return 1;\n}\n',
      '.code-oss/src/src/vs/platform/glyph/common/protocol/Reprinted.ts':
        'export function reprinted() {\n  return 2;\n}\n',
    });
    const result = await build({
      entryPoints: [tracked],
      bundle: true,
      write: false,
      format: 'esm',
      sourcemap: 'inline',
      outfile: join(repositoryRoot, 'out', 'bundle.js'),
    });
    const code = result.outputFiles[0].text;
    await writeTree(repositoryRoot, { 'out/bundle.js': code });

    const converted = await convertProcessCoverage(
      [
        {
          result: [
            {
              scriptId: '1',
              url: pathToFileURL(join(repositoryRoot, 'out', 'bundle.js')).href,
              functions: blockCoverage(code, { helper: 1, reprinted: 1, entry: 1 }),
            },
          ],
        },
      ],
      { repositoryRoot, files: new Set([tracked]) },
    );

    expect(Object.keys(converted)).toEqual([tracked]);
    expect(converted[tracked][0].f).toEqual({ 0: 1 });
  });

  it('ignores scripts that are not files, carry no map, or map only to untracked sources', async () => {
    const repositoryRoot = await temporaryDirectory();
    const tracked = join(repositoryRoot, 'src', 'tracked.ts');
    const { code } = await transform('export function other() {}\n', {
      loader: 'ts',
      format: 'esm',
      sourcemap: 'inline',
      sourcefile: join(repositoryRoot, 'src', 'other.ts'),
    });
    await writeTree(repositoryRoot, { 'out/plain.js': 'export const value = 1;\n', 'out/other.js': code });
    const script = (url, source) => ({ scriptId: '1', url, functions: blockCoverage(source, {}) });

    const converted = await convertProcessCoverage(
      [
        {
          result: [
            script('node:internal/main', 'internal'),
            script(pathToFileURL(join(repositoryRoot, 'out', 'plain.js')).href, 'export const value = 1;\n'),
            script(pathToFileURL(join(repositoryRoot, 'out', 'other.js')).href, code),
          ],
        },
      ],
      { repositoryRoot, files: new Set([tracked]) },
    );

    expect(converted).toEqual({});
  });
});

describe(mergeOntoBaseline, () => {
  function fileCoverage(path, { s, f, b }) {
    return {
      path,
      statementMap: {
        0: { start: { line: 1, column: 0 }, end: { line: 1, column: null } },
        1: { start: { line: 2, column: 2 }, end: { line: 2, column: null } },
        2: { start: { line: 2, column: 2 }, end: { line: 2, column: null } },
      },
      fnMap: {
        0: {
          name: 'run',
          decl: { start: { line: 1, column: 9 }, end: { line: 1, column: 12 } },
          loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } },
          line: 1,
        },
      },
      branchMap: {
        0: {
          type: 'if',
          loc: { start: { line: 2, column: 2 }, end: { line: 2, column: 20 } },
          locations: [
            { start: { line: 2, column: 2 }, end: { line: 2, column: 20 } },
            { start: { line: 2, column: 2 }, end: { line: 2, column: 20 } },
          ],
          line: 2,
        },
      },
      s,
      f,
      b,
    };
  }

  it('adds hits from additions whose locations start where baseline entries start', () => {
    const baseline = {
      '/repo/a.ts': fileCoverage('/repo/a.ts', { s: { 0: 1, 1: 0, 2: 0 }, f: { 0: 1 }, b: { 0: [1, 0] } }),
    };
    const addition = fileCoverage('/repo/a.ts', { s: { 0: 2, 1: 3, 2: 4 }, f: { 0: 5 }, b: { 0: [0, 6] } });
    addition.statementMap[0].end.column = 14;

    const merged = mergeOntoBaseline(baseline, { '/repo/a.ts': [addition, addition] });

    expect(merged['/repo/a.ts'].s).toEqual({ 0: 5, 1: 6, 2: 8 });
    expect(merged['/repo/a.ts'].f).toEqual({ 0: 11 });
    expect(merged['/repo/a.ts'].b).toEqual({ 0: [1, 12] });
    expect(baseline['/repo/a.ts'].s).toEqual({ 0: 1, 1: 0, 2: 0 });
  });

  it('discards addition entries the baseline does not define', () => {
    const baseline = {
      '/repo/a.ts': fileCoverage('/repo/a.ts', { s: { 0: 0, 1: 0, 2: 0 }, f: { 0: 0 }, b: { 0: [0, 0] } }),
    };
    const addition = fileCoverage('/repo/a.ts', { s: { 0: 1, 1: 1, 2: 1 }, f: { 0: 1 }, b: { 0: [1, 1] } });
    addition.statementMap[0].start.column = 4;
    addition.fnMap[0].loc.start.line = 9;
    addition.branchMap[0].type = 'cond-expr';
    delete addition.statementMap[2];

    const merged = mergeOntoBaseline(baseline, {
      '/repo/a.ts': [addition],
      '/repo/untracked.ts': [addition],
    });

    expect(Object.keys(merged)).toEqual(['/repo/a.ts']);
    expect(merged['/repo/a.ts'].s).toEqual({ 0: 0, 1: 1, 2: 0 });
    expect(merged['/repo/a.ts'].f).toEqual({ 0: 0 });
    expect(merged['/repo/a.ts'].b).toEqual({ 0: [0, 0] });
  });

  it('treats impossible negative baseline counts as no evidence of execution', () => {
    const baseline = {
      '/repo/a.ts': fileCoverage('/repo/a.ts', { s: { 0: -1, 1: 2, 2: 0 }, f: { 0: -3 }, b: { 0: [13, -10] } }),
    };
    const addition = fileCoverage('/repo/a.ts', { s: { 0: 0, 1: 0, 2: 0 }, f: { 0: 0 }, b: { 0: [0, 8] } });

    const merged = mergeOntoBaseline(baseline, { '/repo/a.ts': [addition] });

    expect(merged['/repo/a.ts'].s).toEqual({ 0: 0, 1: 2, 2: 0 });
    expect(merged['/repo/a.ts'].f).toEqual({ 0: 0 });
    expect(merged['/repo/a.ts'].b).toEqual({ 0: [13, 8] });
  });

  it('copies baseline files that received no additions', () => {
    const baseline = {
      '/repo/a.ts': fileCoverage('/repo/a.ts', { s: { 0: 1, 1: 0, 2: 0 }, f: { 0: 1 }, b: { 0: [1, 0] } }),
    };

    const merged = mergeOntoBaseline(baseline, {});

    expect(merged).toEqual(baseline);
    expect(merged['/repo/a.ts']).not.toBe(baseline['/repo/a.ts']);
  });
});

describe(findIncompleteFiles, () => {
  it('reports each file with any metric below full coverage, in path order', () => {
    const covered = {
      path: '/repo/covered.ts',
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } } },
      fnMap: {},
      branchMap: {},
      s: { 0: 1 },
      f: {},
      b: {},
    };
    const partial = {
      path: '/repo/partial.ts',
      statementMap: {
        0: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
        1: { start: { line: 2, column: 0 }, end: { line: 2, column: 5 } },
      },
      fnMap: {},
      branchMap: {
        0: {
          type: 'if',
          loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
          locations: [
            { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
            { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
          ],
        },
      },
      s: { 0: 1, 1: 0 },
      f: {},
      b: { 0: [1, 1] },
    };
    const untaken = { ...covered, path: '/repo/a-untaken.ts', branchMap: partial.branchMap, b: { 0: [1, 0] } };

    expect(
      findIncompleteFiles({ '/repo/partial.ts': partial, '/repo/covered.ts': covered, '/repo/a-untaken.ts': untaken }),
    ).toEqual([
      { file: '/repo/a-untaken.ts', statements: 100, branches: 50, functions: 100, lines: 100 },
      { file: '/repo/partial.ts', statements: 50, branches: 100, functions: 100, lines: 50 },
    ]);
  });
});
