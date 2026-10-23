import ts from 'typescript';
import { resolve } from 'node:path';
import { sourceAliasDeclarationTransformer, sourceAliasTransformer } from './imports/source-alias-transformer.mjs';

// Run the normal TypeScript checker and emitter, adding only alias lowering.
// Both local builds and fresh artifact staging must use this same path.
const args = process.argv.slice(2);
if (args.length > 0 && (args.length !== 2 || args[0] !== '--outDir'))
  throw new Error('Usage: node scripts/build.mjs [--outDir directory]');
const configPath = resolve('tsconfig.build.json');
const config = ts.readConfigFile(configPath, path => ts.sys.readFile(path));
const overrides = args.length > 0 ? { outDir: resolve(args[1]) } : {};
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd(), overrides, configPath);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...(config.error ? [config.error] : []), ...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (!diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) {
  diagnostics.push(
    ...program.emit(undefined, undefined, undefined, undefined, {
      before: [sourceAliasTransformer],
      afterDeclarations: [sourceAliasDeclarationTransformer],
    }).diagnostics,
  );
}
if (diagnostics.length > 0) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
      getCanonicalFileName: file => file,
      getNewLine: () => ts.sys.newLine,
    }),
  );
}
if (diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) process.exitCode = 1;
