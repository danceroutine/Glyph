import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  sourceAliasDeclarationTransformer,
  sourceAliasTransformer,
} from '#scripts/imports/source-alias-transformer.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const file = join(root, 'src/desktop/host/Fixture.ts');

describe(sourceAliasTransformer, () => {
  it('emits runnable JavaScript imports, re-exports, and dynamic imports without source aliases', () => {
    const source = [
      "import { GlyphService } from '#src/application/GlyphService.js';",
      'export { GlyphService };',
      "export * from '#src/desktop/protocol/GlyphDesktopError.js';",
      "export const load = () => import('#src/terminal/TerminalUI.js');",
      "export const message = '#src/keep-this-string.js';",
    ].join('\n');
    const result = ts.transpileModule(source, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023, sourceMap: true },
      transformers: { before: [sourceAliasTransformer] },
    });
    expect(result.outputText).toContain('from "../../application/GlyphService.js"');
    expect(result.outputText).toContain('from "../protocol/GlyphDesktopError.js"');
    expect(result.outputText).toContain('import("../../terminal/TerminalUI.js")');
    expect(result.outputText).toContain("'#src/keep-this-string.js'");
    expect(JSON.parse(result.sourceMapText ?? '')).toMatchObject({ sources: ['Fixture.ts'] });
  });

  it('lowers declaration imports and import types so consumers do not need Glyph’s source import map', () => {
    const source = ts.createSourceFile(
      file.replace('.ts', '.d.ts'),
      [
        "import type { GlyphService } from '#src/application/GlyphService.js';",
        'export declare const service: GlyphService;',
        "export type Error = import('#src/desktop/protocol/GlyphDesktopError.js').GlyphDesktopError;",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
    );
    const transformed = ts.transform(source, [sourceAliasTransformer]);
    try {
      const output = ts.createPrinter().printFile(transformed.transformed[0]);
      expect(output).toContain('from "../../application/GlyphService.js"');
      expect(output).toContain('import("../protocol/GlyphDesktopError.js")');
      expect(output).not.toContain('#src/');
    } finally {
      transformed.dispose();
    }
  });

  it('transforms both declaration source files and declaration bundles', () => {
    const source = ts.createSourceFile(
      file.replace('.ts', '.d.ts'),
      "export * from '#src/desktop/protocol/GlyphDesktopError.js';",
      ts.ScriptTarget.Latest,
      true,
    );
    let transformedSource;
    let transformedBundle;
    /** @type {ts.TransformerFactory<ts.SourceFile>} */
    const exerciseDeclarationTransformer = context => sourceFile => {
      const transformer = sourceAliasDeclarationTransformer(context);
      transformedSource = transformer.transformSourceFile(sourceFile);
      transformedBundle = transformer.transformBundle(ts.factory.createBundle([sourceFile]));
      return sourceFile;
    };

    const transformed = ts.transform(source, [exerciseDeclarationTransformer]);
    try {
      const printer = ts.createPrinter();
      expect(printer.printFile(transformedSource)).toContain('from "../protocol/GlyphDesktopError.js"');
      expect(printer.printBundle(transformedBundle)).toContain('from "../protocol/GlyphDesktopError.js"');
    } finally {
      transformed.dispose();
    }
  });

  it('lowers import-equals requires while leaving relative and computed specifiers untouched', () => {
    const result = ts.transpileModule(
      [
        "import service = require('#src/application/GlyphService.js');",
        "import local = require('./local.js');",
        'export const load = (name: string) => import(name);',
        'export const bare = () => import(`./static.js`);',
        'export { service, local };',
      ].join('\n'),
      {
        fileName: file,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
        transformers: { before: [sourceAliasTransformer] },
      },
    );
    expect(result.outputText).toContain('require("../../application/GlyphService.js")');
    expect(result.outputText).toContain('require("./local.js")');
    expect(result.outputText).toContain('Promise.resolve(`${name}`).then(s => require(s))');
    expect(result.outputText).toContain('require(`./static.js`)');
  });

  it('rejects a source alias that tries to leave its source root', () => {
    expect(() =>
      ts.transpileModule("import '#src/../outside.js';", {
        fileName: file,
        transformers: { before: [sourceAliasTransformer] },
      }),
    ).toThrow('Invalid source alias');
  });

  it('keeps first-party parent traversal out of module imports without forbidding relative paths in fixtures', () => {
    const violations = [];
    for (const directory of ['src', 'scripts', 'code-oss', 'examples']) {
      for (const candidate of files(join(root, directory))) {
        if (!/\.(?:[cm]?js|tsx?)$/u.test(candidate)) continue;
        const source = ts.createSourceFile(candidate, readFileSync(candidate, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = node => {
          let specifier;
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
          if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
          if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          )
            specifier = node.arguments[0];
          if (
            specifier &&
            (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) &&
            specifier.text.startsWith('../')
          )
            violations.push(`${candidate}: ${specifier.text}`);
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
    expect(violations).toEqual([]);
  });
});

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.code-oss', '.artifacts'].includes(entry.name)) continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(entryPath);
    else yield entryPath;
  }
}
