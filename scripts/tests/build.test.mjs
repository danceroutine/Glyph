import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

async function project(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'glyph-build-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const config = {
    compilerOptions: {
      outDir: 'dist',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      strict: true,
      skipLibCheck: true,
      sourceMap: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      rootDir: 'src',
      types: [],
    },
    include: ['src/**/*.ts'],
  };
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', imports: { '#src/*': './src/*' } }));
  await writeFile(join(root, 'tsconfig.build.json'), JSON.stringify(config));
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, 'src', name), text);
  return root;
}

async function build(cwd, ...arguments_) {
  const originalArgv = process.argv;
  const workingDirectory = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  onTestFinished(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    workingDirectory.mockRestore();
    stderr.mockRestore();
  });
  process.argv = ['node', 'scripts/build.mjs', ...arguments_];
  vi.resetModules();
  const loaded = import('#scripts/build.mjs');
  const error = await loaded.then(
    () => undefined,
    (/** @type {unknown} */ failure) => failure,
  );
  const output = stderr.mock.calls.map(([text]) => String(text)).join('');
  return { error, exitCode: process.exitCode, stderr: output };
}

describe('build', () => {
  it.each([[['only-one']], [['--out', 'dist']], [['--outDir', 'dist', 'extra']]])(
    'rejects the arguments %j with usage',
    async arguments_ => {
      const root = await project({ 'index.ts': 'export const value = 1;\n' });

      const result = await build(root, ...arguments_);

      expect(result.error).toEqual(new Error('Usage: node scripts/build.mjs [--outDir directory]'));
    },
  );

  it('emits JavaScript and source maps into the configured output directory', async () => {
    const root = await project({ 'index.ts': 'export const value: number = 1;\n' });

    const result = await build(root);

    expect(result).toEqual({ error: undefined, exitCode: undefined, stderr: '' });
    expect((await readdir(join(root, 'dist'))).toSorted()).toEqual(['index.js', 'index.js.map']);
    expect(await readFile(join(root, 'dist', 'index.js'), 'utf8')).toContain('export const value = 1;');
  });

  it('emits into an explicit output directory instead of the configured one', async () => {
    const root = await project({ 'index.ts': 'export const value = 1;\n' });

    const result = await build(root, '--outDir', 'staging');

    expect(result.exitCode).toBeUndefined();
    expect(await readdir(root)).not.toContain('dist');
    expect(await readdir(join(root, 'staging'))).toContain('index.js');
  });

  it('lowers source aliases to the checkout source tree while emitting', async () => {
    const root = await project({
      'index.ts': "export { describeError } from '#src/describeError.js';\n",
      'describeError.ts': 'export function describeError(): string {\n  return "";\n}\n',
    });

    const result = await build(root);

    expect(result.exitCode, result.stderr).toBeUndefined();
    expect(await readFile(join(root, 'dist', 'index.js'), 'utf8')).toMatch(
      /^export \{ describeError \} from "(?:\.\.\/)+.*harness-chat\/src\/describeError\.js";$/mu,
    );
  });

  it('reports type errors without emitting and fails', async () => {
    const root = await project({ 'index.ts': 'export const value: number = "text";\n' });

    const result = await build(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Type 'string' is not assignable to type 'number'.");
    expect(await readdir(root)).not.toContain('dist');
  });

  it('reports an unreadable build configuration and fails', async () => {
    const root = await project({ 'index.ts': 'export const value = 1;\n' });
    await rm(join(root, 'tsconfig.build.json'));

    const result = await build(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('tsconfig.build.json');
  });
});
