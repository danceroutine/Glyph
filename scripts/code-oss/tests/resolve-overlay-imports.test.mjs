import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { resolveOverlayImports } from '#scripts/code-oss/resolve-overlay-imports.mjs';

const repository = fileURLToPath(new URL('../../..', import.meta.url));
const overlay = join(repository, 'code-oss/overlay');
const browser = join(overlay, 'src/vs/workbench/contrib/glyph/browser/GlyphViewPane.ts');

describe(resolveOverlayImports, () => {
  it('resolves Code OSS and shared Glyph imports to runtime-safe paths', () => {
    const input = [
      "import { URI } from '#vs/base/common/uri.js';",
      "import type { GlyphEditorRequest } from '#glyph/protocol/editor/GlyphEditorRequest.js';",
    ].join('\n');
    expect(resolveOverlayImports(input, browser)).toBe(
      [
        "import { URI } from '../../../../base/common/uri.js';",
        "import type { GlyphEditorRequest } from '../../../../platform/glyph/common/protocol/editor/GlyphEditorRequest.js';",
      ].join('\n'),
    );
  });

  it('resolves imports from Electron main as well as the browser', () => {
    const file = join(overlay, 'src/vs/platform/glyph/electron-main/glyphHostStarter.ts');
    expect(resolveOverlayImports("import { Disposable } from '#vs/base/common/lifecycle.js';", file)).toBe(
      "import { Disposable } from '../../../base/common/lifecycle.js';",
    );
  });

  it('resolves re-exports, side effects, import types, and literal dynamic imports', () => {
    const input = [
      'export { URI } from "#vs/base/common/uri.js";',
      "export * from '#glyph/protocol/GlyphDesktopError.js';",
      "import '#vs/workbench/contrib/glyph/browser/ui/mountGlyphWorkbench.css';",
      "type URI = import('#vs/base/common/uri.js').URI;",
      "const load = () => import('#vs/base/common/uri.js');",
      'const lazy = () => import(`#vs/base/common/uri.js`);',
    ].join('\n');
    expect(resolveOverlayImports(input, browser)).toBe(
      [
        'export { URI } from "../../../../base/common/uri.js";',
        "export * from '../../../../platform/glyph/common/protocol/GlyphDesktopError.js';",
        "import './ui/mountGlyphWorkbench.css';",
        "type URI = import('../../../../base/common/uri.js').URI;",
        "const load = () => import('../../../../base/common/uri.js');",
        'const lazy = () => import(`../../../../base/common/uri.js`);',
      ].join('\n'),
    );
  });

  it('preserves comments, ordinary strings, package imports, and local imports', () => {
    const input = [
      "// import { URI } from '#vs/base/common/uri.js';",
      "const message = '#glyph/protocol/editor/GlyphEditorRequest.js';",
      "import { resolve } from 'node:path';",
      "import type { WebContents } from 'electron';",
      "import { GlyphEditorAdapter } from './GlyphEditorAdapter.js';",
    ].join('\n');
    expect(resolveOverlayImports(input, browser)).toBe(input);
  });

  it('leaves computed dynamic imports untouched', () => {
    const input = 'const load = (name: string) => import(name);';
    expect(resolveOverlayImports(input, browser)).toBe(input);
  });

  it('rejects aliases whose configured target leaves the overlay tree', async () => {
    const realFilesystem = await vi.importActual('node:fs');
    vi.resetModules();
    vi.doMock('node:fs', () => ({
      ...realFilesystem,
      readFileSync: () =>
        JSON.stringify({ compilerOptions: { paths: { '#outside/*': ['../outside/*'], '#root/*': ['./overlay*'] } } }),
    }));
    onTestFinished(() => vi.doUnmock('node:fs'));
    const { resolveOverlayImports: resolveWithConfig } = await import('#scripts/code-oss/resolve-overlay-imports.mjs');

    expect(() => resolveWithConfig("import '#outside/module.js';", browser)).toThrow(
      'Code OSS alias #outside/module.js must target the overlay tree',
    );
    expect(() => resolveWithConfig("import '#root/x';", browser)).toThrow(
      'Code OSS alias #root/x must target the overlay tree',
    );
  });

  it('keeps generated imports unchanged when overlay processing runs again', () => {
    const output = resolveOverlayImports("import { URI } from '#vs/base/common/uri.js';", browser);
    expect(resolveOverlayImports(output, browser)).toBe(output);
  });

  it.each(['#missing/module.js', '#vs/../escape.js', '#glyph/../../escape.js', '#vs/'])(
    'rejects an unknown or invalid alias %s instead of emitting an unusable import',
    specifier => {
      expect(() => resolveOverlayImports(`import '${specifier}';`, browser)).toThrow(/Code OSS import alias/);
    },
  );

  it('resolves every checked-in overlay alias to the same target TypeScript uses', () => {
    const configPath = join(repository, 'code-oss/tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
    expect(parsed.errors).toEqual([]);
    let checked = 0;
    for (const file of files(overlay)) {
      if (!file.endsWith('.ts')) continue;
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith('#')) continue;
        const resolution = ts.resolveModuleName(specifier, file, parsed.options, ts.sys).resolvedModule;
        expect(resolution, `${file}: ${specifier}`).toBeDefined();
        const lowered = resolveOverlayImports(`import '${specifier}';`, file).slice(8, -2);
        const generatedFile = file.replace(overlay, join(repository, '.code-oss/src'));
        const generatedResolution = ts.resolveModuleName(lowered, generatedFile, parsed.options, ts.sys).resolvedModule;
        expect(generatedResolution, `${generatedFile}: ${lowered}`).toBeDefined();
        const expected = resolution.resolvedFileName.replace(overlay, join(repository, '.code-oss/src'));
        expect(resolve(generatedResolution.resolvedFileName)).toBe(resolve(expected));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else yield file;
  }
}
