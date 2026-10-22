import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  accumulateBundleCoverage,
  accumulateProcessCoverage,
  isGlyphScript,
  readProcessCoverage,
} from '#scripts/coverage/record-coverage.mjs';

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'glyph-record-coverage-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

describe(isGlyphScript, () => {
  it.each([
    'file:///repo/.artifacts/glyph-desktop-host/dist/desktop/host/utilityMain.js',
    'file:///repo/.code-oss/src/out/vs/platform/glyph/node/glyphHostBootstrap.js',
    'vscode-file://vscode-app/repo/.code-oss/src/out/vs/workbench/contrib/glyph/browser/GlyphViewPane.js',
  ])('accepts Glyph-owned script %s', url => {
    expect(isGlyphScript(url)).toBe(true);
  });

  it.each([
    'file:///repo/.artifacts/glyph-desktop-host/dist/node_modules/zod/index.js',
    'file:///repo/.code-oss/src/out/vs/workbench/contrib/terminal/browser/terminal.js',
    'node:internal/process/task_queues',
  ])('rejects foreign script %s', url => {
    expect(isGlyphScript(url)).toBe(false);
  });
});

describe(readProcessCoverage, () => {
  it('returns no processes for a missing directory', async () => {
    const directory = await temporaryDirectory();
    expect(await readProcessCoverage(join(directory, 'missing'))).toEqual([]);
  });

  it('reads every JSON dump beneath the directory in name order', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'nested'));
    const b = { scriptId: '1', url: 'b', functions: [] };
    const a = { scriptId: '2', url: 'a', functions: [] };
    await writeFile(join(directory, 'b.json'), JSON.stringify({ result: [b], timestamp: 2 }));
    await writeFile(join(directory, 'nested', 'a.json'), JSON.stringify({ result: [a] }));
    await writeFile(join(directory, 'notes.txt'), 'ignored');

    expect(await readProcessCoverage(directory)).toEqual([{ result: [b] }, { result: [a] }]);
  });

  it('propagates failures other than a missing directory', async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'file.json');
    await writeFile(file, '{}');

    await expect(readProcessCoverage(file)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe(accumulateProcessCoverage, () => {
  it('writes only Glyph scripts without their source text', async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'nested', 'electron-0.json');
    const glyph = {
      scriptId: '1',
      url: 'file:///repo/.code-oss/src/out/vs/platform/glyph/node/glyphHostBootstrap.js',
      source: 'console.log(1);',
      functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 15, count: 1 }] }],
    };
    const foreign = { ...glyph, scriptId: '2', url: 'file:///repo/.code-oss/src/out/main.js' };

    await accumulateProcessCoverage(file, [{ result: [glyph, foreign] }]);

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      result: [
        {
          scriptId: '0',
          url: glyph.url,
          functions: [
            { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 15, count: 1 }] },
          ],
        },
      ],
    });
  });

  it('adds new hits to the previously accumulated counts', async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, 'electron-0.json');
    const script = count => ({
      scriptId: '1',
      url: 'file:///repo/.artifacts/glyph-desktop-host/dist/desktop/host/utilityMain.js',
      functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 10, count }] }],
    });

    await accumulateProcessCoverage(file, [{ result: [script(1)] }]);
    await accumulateProcessCoverage(file, [{ result: [script(2)] }, { result: [script(4)] }]);

    const recorded = /** @type {import('#scripts/coverage/record-coverage.mjs').ProcessCoverage} */ (
      JSON.parse(await readFile(file, 'utf8'))
    );
    expect(recorded.result[0].functions[0].ranges).toEqual([{ startOffset: 0, endOffset: 10, count: 7 }]);
  });

  it('propagates failures other than a missing accumulation file', async () => {
    const directory = await temporaryDirectory();
    await expect(accumulateProcessCoverage(directory, [])).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe(accumulateBundleCoverage, () => {
  it('stores each source-mapped bundle once and records its coverage against the stored file', async () => {
    const directory = await temporaryDirectory();
    const source = 'render();\n//# sourceMappingURL=data:application/json;base64,e30=\n';
    const hash = createHash('sha256').update(source).digest('hex');
    const bundle = count => ({
      scriptId: '7',
      url: '',
      source,
      functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 9, count }] }],
    });

    await accumulateBundleCoverage(directory, 'components-1.json', [bundle(1)]);
    await accumulateBundleCoverage(directory, 'components-1.json', [
      bundle(2),
      { scriptId: '8', url: '', source: 'plain();', functions: [] },
      { scriptId: '9', url: 'https://example.test/library.js', functions: [] },
    ]);

    expect(await readdir(join(directory, 'sources'))).toEqual([`${hash}.js`]);
    expect(await readFile(join(directory, 'sources', `${hash}.js`), 'utf8')).toBe(source);
    expect(JSON.parse(await readFile(join(directory, 'components-1.json'), 'utf8'))).toEqual({
      result: [
        {
          scriptId: '0',
          url: pathToFileURL(join(directory, 'sources', `${hash}.js`)).href,
          functions: [
            { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 9, count: 3 }] },
          ],
        },
      ],
    });
  });

  it('propagates failures to store a bundle source', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'sources'));
    await chmod(join(directory, 'sources'), 0o500);
    onTestFinished(() => chmod(join(directory, 'sources'), 0o700));

    await expect(
      accumulateBundleCoverage(directory, 'components-1.json', [
        { scriptId: '1', url: '', source: 'x();\n//# sourceMappingURL=data:,{}', functions: [] },
      ]),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('propagates failures to read an existing accumulation', async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, 'components-1.json'));

    await expect(accumulateBundleCoverage(directory, 'components-1.json', [])).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });
});
