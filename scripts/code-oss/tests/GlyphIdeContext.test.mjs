import { build } from 'esbuild';
import { resolve } from 'node:path';
import { beforeAll, expect, it, vi } from 'vitest';
import { importBundle } from '#scripts/code-oss/tests/support/bundle.mjs';

/**
 * @typedef {{
 *   GlyphIdeContext: typeof import('#vs/workbench/contrib/glyph/browser/GlyphIdeContext.js').GlyphIdeContext,
 *   URI: typeof import('#vs/base/common/uri.js').URI,
 *   Range: typeof import('#vs/editor/common/core/range.js').Range,
 *   Emitter: typeof import('#vs/base/common/event.js').Emitter,
 * }} IdeContextModule
 */

/** @type {IdeContextModule['Emitter']} */
let Emitter;
/** @type {IdeContextModule['GlyphIdeContext']} */
let GlyphIdeContext;
/** @type {IdeContextModule['Range']} */
let Range;
/** @type {IdeContextModule['URI']} */
let URI;
beforeAll(async () => {
  const built = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      export { GlyphIdeContext } from './code-oss/overlay/src/vs/workbench/contrib/glyph/browser/GlyphIdeContext.ts';
      export { URI } from '#vs/base/common/uri.js';
      export { Range } from '#vs/editor/common/core/range.js';
      export { Emitter } from '#vs/base/common/event.js';
    `,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    plugins: [
      {
        name: 'injected-workbench-services',
        setup(builder) {
          builder.onResolve({ filter: /^#vs\// }, args => {
            if (
              args.path.startsWith('#vs/base/') ||
              args.path.startsWith('#vs/editor/common/core/') ||
              args.path.endsWith('/markers.js') ||
              args.path.endsWith('/testingUri.js') ||
              args.path.endsWith('/capabilities.js')
            )
              return { path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) };
            return { path: args.path, namespace: 'service' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'service' }, args => ({
            contents: args.path.endsWith('/goToSymbol.js')
              ? `export const getDefinitionsAtPosition = (...args) => globalThis.glyphIdeQueries.definition(...args);
           export const getReferencesAtPosition = (...args) => globalThis.glyphIdeQueries.reference(...args);`
              : `const service = () => {}; export { service as ILanguageFeaturesService, service as ITextModelService, service as IQuickInputService, service as ISCMService, service as ITerminalService, service as ITestResultService, service as IWorkspaceTrustManagementService };`,
          }));
          builder.onResolve({ filter: /^#glyph\// }, args => ({
            path: resolve('src/desktop', args.path.slice(7).replace(/\.js$/, '.ts')),
          }));
        },
      },
    ],
  });
  /** @type {IdeContextModule} */
  const api = await importBundle(built.outputFiles[0].text, ['GlyphIdeContext', 'URI', 'Range', 'Emitter']);
  ({ GlyphIdeContext, URI, Range, Emitter } = api);
});

/**
 * @param {{
 *   choices?: (string | ((items: { label: string }[]) => unknown))[],
 *   marker?: unknown,
 *   definitions?: boolean,
 *   references?: boolean,
 *   terminal?: unknown,
 *   repositories?: unknown[],
 *   runs?: { id: string }[],
 *   text?: string,
 *   language?: string,
 * }} [options]
 */
function fixture({
  choices = [],
  marker,
  definitions = false,
  references = false,
  terminal,
  repositories = [],
  runs = [],
  text = 'value',
  language = 'plaintext',
} = {}) {
  let version = 1;
  const change = new Emitter();
  const uri = URI.file('/workspace/a.txt');
  const model = {
    uri,
    isDisposed: () => false,
    getVersionId: () => version,
    getLanguageId: () => language,
    getLineCount: () => 1,
    getLineContent: () => text,
    getLineMaxColumn: () => text.length + 1,
    getValue: () => text,
    getValueLength: () => text.length,
    getOffsetAt: () => 0,
    getPositionAt: (/** @type {number} */ offset) => ({ lineNumber: 1, column: offset + 1 }),
    validateRange: (/** @type {unknown} */ range) => range,
    onDidChangeContent: change.event,
  };
  const capture = vi.fn(async () => ({
    id: 'original',
    kind: 'selection',
    uri: uri.toString(),
    path: 'a.txt',
    text,
    sourceRevision: `editor:${version}`,
    token: { version },
    contentRevision: 'source-hash',
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
  }));
  const adapter = {
    captureContext: capture,
    contextPath: (/** @type {import('#vs/base/common/uri.js').URI} */ target) => {
      if (!target.path.startsWith('/workspace/')) throw new Error('Outside workspace');
      return target.path.slice(11);
    },
  };
  const quick = {
    pick: vi.fn(async (/** @type {{ label: string }[]} */ items) => {
      const choice = choices.shift();
      return typeof choice === 'function' ? choice(items) : items.find(item => item.label === choice);
    }),
  };
  const trust = { isWorkspaceTrusted: () => true };
  const markers = { read: () => (marker === undefined ? [] : [marker]) };
  const resolver = { createModelReference: vi.fn(async () => ({ object: { textEditorModel: model }, dispose() {} })) };
  const terminals = {
    activeInstance: terminal,
    getInstanceFromId: () => terminal,
    setActiveInstance: vi.fn(),
    revealActiveTerminal: vi.fn(),
  };
  const tests = { results: runs, getResult: id => runs.find(run => run.id === id) };
  const service = new GlyphIdeContext(
    adapter,
    markers,
    {
      definitionProvider: {
        has: () => definitions,
        ordered: () => [{ provideDefinition: (...args) => globalThis.glyphIdeQueries.definition(...args) }],
      },
      referenceProvider: {
        has: () => references,
        ordered: () => [{ provideReferences: (...args) => globalThis.glyphIdeQueries.reference(...args) }],
      },
    },
    resolver,
    quick,
    { repositories },
    terminals,
    tests,
    trust,
  );
  const editor = { getModel: () => model, getSelection: () => new Range(1, 1, 1, 6) };
  globalThis.glyphIdeQueries = { definition: vi.fn(async () => []), reference: vi.fn(async () => []) };
  return {
    service,
    editor,
    quick,
    capture,
    trust,
    markers,
    resolver,
    uri,
    model,
    terminals,
    edit: (/** @type {string} */ value) => {
      text = value;
      version++;
      change.fire({});
    },
  };
}

it('does not query workbench data in an untrusted workspace', async () => {
  const f = fixture();
  f.trust.isWorkspaceTrusted = () => false;
  await expect(f.service.select(f.editor)).rejects.toThrow('Trust this workspace');
  expect(f.quick.pick).not.toHaveBeenCalled();
});

it('preserves stale diagnostic provenance and labels providers without a revision', async () => {
  for (const modelVersionId of [0, undefined]) {
    const f = fixture({ choices: ['Diagnostic', items => items[0]] });
    f.markers.read = () => [marker];
    const marker = {
      resource: f.uri,
      message: 'Original issue',
      owner: 'fixture',
      severity: 8,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 6,
      modelVersionId,
    };
    const [attachment] = await f.service.select(f.editor);
    expect(attachment.text).toContain(modelVersionId === undefined ? 'freshness unknown' : 'stale:');
    expect(attachment).toMatchObject({
      kind: 'diagnostic',
      sourceRevision: 'editor:1',
      text: expect.stringContaining('Original issue'),
    });
  }
});

it('discards a delayed language response after a source edit, preserving the selected snapshot', async () => {
  const f = fixture({ choices: ['Related symbols'], definitions: true });
  let resolveQuery;
  globalThis.glyphIdeQueries.definition = vi.fn(
    () =>
      new Promise(settle => {
        resolveQuery = settle;
      }),
  );
  const pending = f.service.select(f.editor);
  await vi.waitFor(() => {
    expect(resolveQuery).toBeTypeOf('function');
  });
  f.edit('replacement');
  const captures = await pending;
  expect(captures).toHaveLength(1);
  expect(captures[0].text).toContain('stale: editor changed');
  expect(captures[0].text).toContain('Selected code:\nvalue');
  resolveQuery([{ uri: f.uri, range: new Range(1, 1, 1, 6) }]);
  expect(f.resolver.createModelReference).not.toHaveBeenCalled();
});

it('marks timeouts as partial and remains bounded even if a language provider ignores cancellation', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture({ choices: ['Related symbols'], definitions: true });
    globalThis.glyphIdeQueries.definition = () => new Promise(() => {});
    const pending = f.service.select(f.editor);
    await vi.advanceTimersByTimeAsync(5100);
    const captures = await pending;
    expect(captures).toHaveLength(1);
    expect(captures[0].text).toContain('partial: language-service timeout');
  } finally {
    vi.useRealTimers();
  }
});

it('omits out-of-workspace definitions before resolving their contents', async () => {
  const f = fixture({ choices: ['Related symbols'], definitions: true });
  globalThis.glyphIdeQueries.definition = async () => [
    { uri: URI.file('/private/secret.txt'), range: new Range(1, 1, 1, 6) },
  ];
  const captures = await f.service.select(f.editor);
  expect(captures).toHaveLength(1);
  expect(captures[0].text).toContain('1 results omitted');
  expect(f.resolver.createModelReference).not.toHaveBeenCalled();
});

it('rejects oversized terminal captures and never guesses their command identity', async () => {
  const terminal = {
    instanceId: 3,
    title: 'Build',
    selection: 'x'.repeat(512 * 1024),
    capabilities: { get: () => undefined },
  };
  const f = fixture({ choices: ['Terminal selection', 'Terminal selection'], terminal });
  await expect(f.service.select(f.editor)).rejects.toThrow('512 KiB');
  terminal.selection = 'only selected output';
  const [capture] = await f.service.select(f.editor);
  expect(capture.text).toContain('Command: unavailable:');
  expect(capture.text).toContain('only selected output');
  const fresh = fixture({ terminal });
  await expect(fresh.service.openSource(URI.parse(capture.uri), {})).rejects.toThrow('Terminal closed');
});

it('does not allocate an oversized test output or capture a different run', async () => {
  const getRange = vi.fn();
  const task = { name: 'Selected task', id: 'task', ctrlId: 'provider', output: { length: 512 * 1024, getRange } };
  const f = fixture({
    choices: ['Test output', 'Selected task'],
    runs: [{ name: 'Selected run', id: 'run', tasks: [task] }],
  });
  await expect(f.service.select(f.editor)).rejects.toThrow('too large');
  expect(getRange).not.toHaveBeenCalled();
});

it('reports failed language queries as unavailable instead of calling them successful empty results', async () => {
  const f = fixture({ choices: ['Related symbols'], definitions: true, references: true });
  globalThis.glyphIdeQueries.definition = async () => {
    throw new Error('Provider stopped');
  };
  const [capture] = await f.service.select(f.editor);
  expect(capture.text).toContain('failed queries');
  expect(capture.text).not.toContain('0 failed queries');
});

it('attributes selected terminal output only when it falls within one detected command', async () => {
  const terminal = {
    instanceId: 7,
    title: 'Tests',
    selection: 'one output line',
    xterm: { raw: { getSelectionPosition: () => ({ start: { x: 0, y: 4 }, end: { x: 15, y: 4 } }) } },
    capabilities: {
      get: () => ({
        commands: [
          {
            command: 'pnpm test',
            cwd: '/workspace',
            marker: { line: 2 },
            executedMarker: { line: 3 },
            endMarker: { line: 5 },
          },
        ],
      }),
    },
  };
  const f = fixture({ choices: ['Terminal selection'], terminal });
  const [capture] = await f.service.select(f.editor);
  expect(capture.text).toContain('Command: pnpm test');
  expect(capture.text).toContain('Working directory: /workspace');
  expect(capture.text).toContain('Selected output:\none output line');
});

it('preserves the exact test-output resource and selected range for source navigation', async () => {
  const task = { id: 'task', name: 'Task', ctrlId: 'provider' };
  const f = fixture({ runs: [{ id: 'run', name: 'Run', tasks: [task] }] });
  f.model.uri = URI.parse('vscode-test-data://results/run/message/0/0/TestFailureMessage?provider%00test');
  f.model.getValueInRange = () => 'selected failure message';
  const capture = await f.service.captureTestSelection(f.model, new Range(2, 1, 2, 8));
  const editors = { openEditor: vi.fn((/** @type {{ resource: { toString(): string } }} */ _input) => undefined) };
  await f.service.openSource(URI.parse(capture.uri), editors, capture.range);
  expect(capture.text).toContain('selected failure message');
  expect(editors.openEditor.mock.calls[0][0].resource.toString()).toBe(f.model.uri.toString());
  expect(editors.openEditor.mock.calls[0][0]).toMatchObject({
    options: { selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 8 } },
  });
});

it('captures the exact historical test failure with expected/actual and source identity', async () => {
  const task = { id: 'task', name: 'Old task', ctrlId: 'provider' };
  const message = {
    message: 'old failure',
    expected: 'one',
    actual: 'two',
    location: { uri: URI.file('/workspace/a.txt'), range: new Range(3, 1, 3, 4) },
  };
  const test = { item: { extId: 'provider\0test', label: 'Historical case' }, tasks: [{ messages: [message] }] };
  const f = fixture({
    runs: [
      { id: 'new', name: 'New run', tasks: [task] },
      { id: 'old', name: 'Old run', completedAt: 1, tasks: [task], getStateById: () => test },
    ],
  });
  f.model.uri = URI.parse('vscode-test-data://results/old/message/0/0/TestFailureMessage?provider%00test');
  f.model.getFullModelRange = () => new Range(1, 1, 1, 12);
  f.model.getValueInRange = () => 'old failure';
  const [capture] = await f.service.captureTestFailure('old', 'provider\0test', 0, 0);
  expect(capture.text).toContain('Run ID: old');
  expect(capture.text).toContain('Expected: one\nActual: two');
  expect(capture.text).toContain('a.txt:3');
  expect(capture.text).not.toContain('New run');
  await expect(f.service.captureTestFailure('missing', 'provider\0test', 0, 0)).rejects.toThrow('no longer available');
});
