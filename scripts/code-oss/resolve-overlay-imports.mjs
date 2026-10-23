import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';

const codeOssRoot = fileURLToPath(new URL('../../code-oss', import.meta.url));
const overlayRoot = resolve(codeOssRoot, 'overlay');
const config = z
  .object({ compilerOptions: z.object({ paths: z.record(z.string(), z.array(z.string())) }) })
  .parse(JSON.parse(readFileSync(resolve(codeOssRoot, 'tsconfig.json'), 'utf8')));
const aliases = Object.entries(config.compilerOptions.paths).filter(([name]) => name.startsWith('#'));

/**
 * Lower source aliases before handing files to upstream's compiler. Both Node
 * and Chromium then load ordinary ESM without a runtime loader or import map.
 * Read the IDE's path mapping so typechecking and emitted imports cannot drift.
 */
/**
 * @param {string} contents
 * @param {string} file
 */
export function resolveOverlayImports(contents, file) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
  /** @type {{ start: number, end: number, path: string }[]} */
  const edits = [];
  /** @param {ts.Node} node */
  const visit = node => {
    /** @type {ts.Expression | undefined} */
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments.at(0);
      if (argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
        specifier = argument;
      }
    }
    if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
      const value = specifier.text;
      if (value.startsWith('#')) {
        const mapping = aliases.find(([pattern]) => value.startsWith(pattern.slice(0, -1)));
        if (!mapping) throw new Error(`Unknown Code OSS import alias ${value} in ${file}`);
        const [pattern, targets] = mapping;
        const suffix = value.slice(pattern.length - 1);
        if (suffix === '' || suffix.split(/[\\/]/u).includes('..') || suffix.includes('\\'))
          throw new Error(`Invalid Code OSS import alias ${value} in ${file}`);
        const target = resolve(codeOssRoot, targets[0].replace('*', suffix));
        const withinOverlay = relative(overlayRoot, target);
        if (withinOverlay.startsWith('..') || withinOverlay === '')
          throw new Error(`Code OSS alias ${value} must target the overlay tree`);
        let path = relative(dirname(file), target).split(sep).join('/');
        if (!path.startsWith('.')) path = `./${path}`;
        edits.push({ start: specifier.getStart(source) + 1, end: specifier.getEnd() - 1, path });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // Reverse offsets preserve comments, formatting, and non-import string literals.
  for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
    contents = contents.slice(0, edit.start) + edit.path + contents.slice(edit.end);
  }
  return contents;
}
