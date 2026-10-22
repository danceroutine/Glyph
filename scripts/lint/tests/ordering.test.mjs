import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const root = fileURLToPath(new URL('../../../', import.meta.url));
const directories = [];
const imports = "import type { Meta, StoryObj as StoryDefinition } from '@storybook/preact-vite';\n";
const meta = 'const meta = { title: "Example" } satisfies Meta;\n';
const defaultExport = 'export default meta;\n';
const storyType = 'type Story = StoryDefinition<typeof meta>;\n';
const stories = 'export const Zebra: Story = {};\nexport const Alpha: Story = { ...Zebra };\n';

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** @param {string} text */
function fixture(text, filename = 'Example.stories.ts') {
  const directory = mkdtempSync(join(tmpdir(), 'glyph-order-'));
  directories.push(directory);
  /** @type {{ jsPlugins: string[], plugins: string[], categories: Record<string, string>, rules: Record<string, unknown> }} */
  const config = JSON.parse(readFileSync(join(root, '.oxlintrc.json'), 'utf8'));
  config.jsPlugins = config.jsPlugins.map(plugin =>
    plugin.startsWith('.') ? join(root, plugin) : fileURLToPath(import.meta.resolve(plugin)),
  );
  config.plugins = [];
  config.categories = { correctness: 'off' };
  config.rules = Object.fromEntries(Object.entries(config.rules).filter(([name]) => name.includes('/')));
  const configPath = join(directory, '.oxlintrc.json');
  const file = join(directory, filename);
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(file, text);
  const lint = (fix = false) => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'node_modules/oxlint/bin/oxlint'), '-c', configPath, '--no-ignore', ...(fix ? ['--fix'] : []), file],
      { encoding: 'utf8', timeout: 20000 },
    );
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr, text: readFileSync(file, 'utf8') };
  };
  return lint;
}

it('loads Perfectionist in Oxlint and groups methods while preserving fields and method order', () => {
  const lint = fixture(
    `export class Example {
  private helper() { return this.first; }
  private first = record('first');
  public second = record('second');
  protected third = record('third');
  callback = () => this.first;
  #secret() { return this.second; }
  zebra() { return this.helper(); }
  constructor() {}
  protected hook() {}
  alpha() { return this.#secret(); }
  get value() { return this.first; }
  static create() { return new Example(); }
}
`,
    'Example.ts',
  );
  expect(lint().output).toContain('sort-classes');
  lint(true);
  const fixed = lint();
  expect(fixed.status, fixed.output).toBe(0);
  const names = [
    'private first',
    'public second',
    'protected third',
    'callback =',
    'constructor()',
    'static create()',
    'zebra()',
    'alpha()',
    'get value()',
    'protected hook()',
    'private helper()',
    '#secret()',
  ];
  const positions = names.map(name => fixed.text.indexOf(`\n  ${name}`));
  expect(positions.every(position => position >= 0)).toBe(true);
  expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  expect(lint(true).text).toBe(fixed.text);
});

it('accepts ordered CSF with helpers and preserves authored story order', () => {
  const source = imports + meta + defaultExport + storyType + 'const helper = makeFixture();\n' + stories;
  const result = fixture(source)(true);
  expect(result.status, result.output).toBe(0);
  expect(result.text).toBe(source);
});

it('autofixes a late default export and Story type, carrying their comments', () => {
  const lint = fixture(
    imports +
      meta +
      stories +
      '// Metadata export\n' +
      defaultExport +
      '/** Story documentation. */\n' +
      storyType.trimEnd() +
      ' // shared type\n',
  );
  expect(lint().output).toContain('declaration-order');
  // Oxlint applies one pass: the default export moves first, then the type alias.
  lint(true);
  lint(true);
  const fixed = lint();
  expect(fixed.status, fixed.output).toBe(0);
  expect(fixed.text).toBe(
    imports +
      meta +
      '// Metadata export\n' +
      defaultExport +
      '/** Story documentation. */\n' +
      storyType.trimEnd() +
      ' // shared type\n' +
      stories,
  );
  expect(lint(true).text).toBe(fixed.text);
});

it('moves an early Story type after the default export', () => {
  const fixed = fixture(imports + storyType + meta + defaultExport + stories)(true);
  expect(fixed.status, fixed.output).toBe(0);
  expect(fixed.text).toBe(imports + meta + defaultExport + storyType + stories);
});

it('reports late meta without moving runtime initialization', () => {
  const source =
    imports +
    stories +
    'const title = computeTitle();\n' +
    'const meta = { title } satisfies Meta;\n' +
    defaultExport +
    storyType;
  const result = fixture(source)(true);
  expect(result.status).toBe(1);
  expect(result.output).toContain('declaration-order');
  expect(result.text).toBe(source);
});

it('does not move an export of a mutable metadata binding', () => {
  const source =
    imports +
    meta.replace('const meta', 'let meta') +
    stories +
    'meta = { title: "Changed" };\n' +
    defaultExport +
    storyType;
  const result = fixture(source)(true);
  expect(result.status).toBe(1);
  expect(result.text).toBe(source);
});

it('accepts inline default metadata and reports it when it follows stories', () => {
  const inline = 'export default { title: "Inline" } satisfies Meta;\n';
  expect(fixture(imports + inline + stories)().status).toBe(0);
  const source = imports + stories + inline;
  const result = fixture(source)(true);
  expect(result.status).toBe(1);
  expect(result.text).toBe(source);
});

it('limits the Storybook rule to story files', () => {
  const source = imports + stories + meta + defaultExport + storyType;
  const result = fixture(source, 'Example.ts')(true);
  expect(result.status, result.output).toBe(0);
  expect(result.text).toBe(source);
});

it('preserves static initialization order and arrow-property capture order', () => {
  const source = `export class Example {
  static first = record('first');
  static { record('block'); }
  static second = record('second');
  private callback = () => 1;
  public captured = this.callback;
  constructor() {}
  run() { return this.captured(); }
}
`;
  const result = fixture(source, 'Example.ts')(true);
  expect(result.status, result.output).toBe(0);
  expect(result.text).toBe(source);
});

it('reports a default export before its metadata declaration without moving it', () => {
  const source = imports + defaultExport + meta + storyType + stories;
  const result = fixture(source)(true);
  expect(result.status).toBe(1);
  expect(result.text).toBe(source);
});

it('does not rewrite compact statements or attached lint directives', () => {
  for (const ending of ['export default meta; const untouched = 1;\n', '// prettier-ignore\n' + defaultExport]) {
    const source = imports + meta + stories + ending;
    const result = fixture(source)(true);
    expect(result.status).toBe(1);
    expect(result.text).toBe(source);
  }
});

it('leaves story files without a default export to CSF validation', () => {
  const source = imports + stories + meta;
  const result = fixture(source)(true);
  expect(result.status, result.output).toBe(0);
  expect(result.text).toBe(source);
});

it('treats local value export lists as stories while ignoring type-only and re-exported lists', () => {
  const ignored = "export { type Story as Shared };\nexport { Remote } from './Remote';\n";
  const ordered = fixture(imports + meta + ignored + defaultExport + storyType)();
  expect(ordered.status, ordered.output).toBe(0);
  const source = imports + meta + 'const Local = {};\nexport { Local };\n' + defaultExport;
  const lint = fixture(source);
  expect(lint().output).toContain('declaration-order');
  expect(lint(true).text).toBe(imports + meta + defaultExport + 'const Local = {};\nexport { Local };\n');
});

it('keeps a comment that trails code on its own line when moving the next declaration', () => {
  const fixed = fixture(imports + meta + stories + 'const helper = 1; // helper note\n' + defaultExport)(true);
  expect(fixed.text).toBe(imports + meta + defaultExport + stories + 'const helper = 1; // helper note\n');
});

it('terminates a moved final declaration that had no trailing newline', () => {
  const fixed = fixture(imports + meta + stories + defaultExport.trimEnd())(true);
  expect(fixed.text).toBe(imports + meta + defaultExport + stories);
});

it('also enforces ordering for JavaScript function stories', () => {
  const lint = fixture(
    meta.replace(' satisfies Meta', '') + 'export function Primary() { return null; }\n' + defaultExport,
    'Example.stories.jsx',
  );
  expect(lint().output).toContain('declaration-order');
  lint(true);
  expect(lint().status).toBe(0);
});
