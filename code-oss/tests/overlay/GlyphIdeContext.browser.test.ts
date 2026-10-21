import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphIdeContext } from '#vs/workbench/contrib/glyph/browser/GlyphIdeContext.js';
import { URI } from '#vs/base/common/uri.js';
import { Range } from '#vs/editor/common/core/range.js';
import { MarkerSeverity, type IMarker } from '#vs/platform/markers/common/markers.js';
import { TerminalCapability } from '#vs/platform/terminal/common/capabilities/capabilities.js';
import { buildTestUri, TestUriType } from '#vs/workbench/contrib/testing/common/testingUri.js';
import { createTextModel } from '#vs/editor/test/common/testTextModel.js';
import type { ITextModel } from '#vs/editor/common/model.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#glyph/protocol/connection/GlyphContextAttachment.js';
import type { GlyphTextRange } from '#glyph/protocol/connection/GlyphTextRange.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';

type Choice = string | ((items: readonly { label: string }[]) => unknown);

interface TestTask {
  id: string;
  name: string;
  ctrlId: string;
  output: { length: number; getRange(start: number, end: number): { toString(): string } };
}

interface TestRun {
  id: string;
  name: string;
  completedAt?: number;
  tasks: TestTask[];
  getStateById?(id: string): unknown;
}

function ideServices() {
  const models: ITextModel[] = [];
  const markers: IMarker[] = [];
  const choices: Choice[] = [];
  const runs: TestRun[] = [];
  const contextPath = vi.fn((uri: URI) => {
    if (uri.scheme === 'untitled') return uri.path;
    if (!uri.path.startsWith('/workspace/')) throw new Error('Outside of the workspace');
    return uri.path.slice('/workspace/'.length);
  });
  const services = {
    models,
    markers,
    choices,
    runs,
    model: (uri: URI, text: string, languageId: string | null = null) => {
      const model = createTextModel(text, languageId, undefined, uri);
      onTestFinished(() => model.dispose());
      models.push(model);
      return model;
    },
    adapter: {
      contextPath,
      captureContext: vi.fn(async (model: ITextModel, range?: GlyphTextRange): Promise<GlyphContextAttachment> => {
        const text = range
          ? model.getValueInRange(new Range(range.start.line, range.start.column, range.end.line, range.end.column))
          : model.getValue();
        return {
          id: 'capture',
          kind: range ? GlyphContextAttachmentKind.SELECTION : GlyphContextAttachmentKind.FILE,
          uri: model.uri.toString(),
          path: contextPath(model.uri),
          text,
          contentRevision: 'revision',
          sourceRevision: `editor:${model.getVersionId()}`,
          token: {
            workspaceGeneration: 'generation',
            resource: model.uri.toString(),
            incarnation: 'incarnation',
            version: model.getVersionId(),
          },
          ...(range ? { range } : {}),
        };
      }),
    },
    markerService: {
      read: vi.fn((filter?: { resource: URI }) =>
        markers.filter(marker => !filter || marker.resource.toString() === filter.resource.toString()),
      ),
    },
    languages: {
      definitionProvider: {
        has: vi.fn(() => false),
        ordered: vi.fn((): { provideDefinition: (...args: unknown[]) => unknown }[] => []),
      },
      referenceProvider: {
        has: vi.fn(() => false),
        ordered: vi.fn((): { provideReferences: (...args: unknown[]) => unknown }[] => []),
      },
    },
    resolver: {
      createModelReference: vi.fn(async (uri: URI) => ({
        object: { textEditorModel: models.find(model => model.uri.toString() === uri.toString())! },
        dispose: vi.fn(),
      })),
    },
    quick: {
      pick: vi.fn(async (items: readonly { label: string }[]) => {
        const choice = choices.shift();
        return typeof choice === 'function' ? choice(items) : items.find(item => item.label === choice);
      }),
    },
    scm: { repositories: [] as unknown[] },
    terminals: {
      activeInstance: undefined as unknown,
      getInstanceFromId: vi.fn((_id: number): unknown => undefined),
      setActiveInstance: vi.fn(),
      revealActiveTerminal: vi.fn(async () => {}),
    },
    tests: { results: runs, getResult: (id: string) => runs.find(run => run.id === id) },
    trust: { isWorkspaceTrusted: vi.fn(() => true) },
  };
  return services;
}

type IdeServices = ReturnType<typeof ideServices>;

function createIdeContext(services: IdeServices) {
  return new GlyphIdeContext(
    services.adapter as never,
    services.markerService as never,
    services.languages as never,
    services.resolver as never,
    services.quick as never,
    services.scm as never,
    services.terminals as never,
    services.tests as never,
    services.trust as never,
  );
}

function editorOf(model: ITextModel, selection: Range | null = new Range(1, 1, 1, 6)) {
  return { getModel: () => model, getSelection: () => selection } as never;
}

function marker(resource: URI, overrides: Partial<IMarker> = {}): IMarker {
  return {
    resource,
    owner: 'typescript',
    code: undefined,
    severity: MarkerSeverity.Error,
    message: 'Broken value',
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 6,
    ...overrides,
  };
}

function testTask(overrides: Partial<TestTask> = {}): TestTask {
  return {
    id: 'task',
    name: 'Unit tests',
    ctrlId: 'vitest',
    output: { length: 6, getRange: () => ({ toString: () => 'output' }) },
    ...overrides,
  };
}

describe(GlyphIdeContext, () => {
  describe(GlyphIdeContext.prototype.select, () => {
    it('refuses to offer context in an untrusted workspace', async () => {
      const services = ideServices();
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      await expect(createIdeContext(services).select(undefined)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
      });
      expect(services.quick.pick).not.toHaveBeenCalled();
    });

    it('returns nothing when no kind of context is chosen', async () => {
      expect(await createIdeContext(ideServices()).select(undefined)).toEqual([]);
    });

    it('returns nothing for an unrecognized kind of context', async () => {
      const services = ideServices();
      services.choices.push(() => ({ label: 'Other', kind: 'other' }));
      expect(await createIdeContext(services).select(undefined)).toEqual([]);
    });

    it('attaches a chosen diagnostic from the workspace', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'value = 1');
      services.markers.push(
        marker(URI.file('/elsewhere/b.ts'), { message: 'Outside' }),
        marker(model.uri, { source: 'eslint', modelVersionId: 1 }),
      );
      let offered: readonly { label: string }[] = [];
      services.choices.push('Diagnostic', items => {
        offered = items;
        return items[0];
      });
      const [attachment] = await createIdeContext(services).select(editorOf(model));
      expect(offered).toMatchObject([{ label: 'Broken value', description: 'a.ts:1' }]);
      expect(attachment).toMatchObject({ kind: GlyphContextAttachmentKind.DIAGNOSTIC, path: 'a.ts' });
      expect(attachment.text).toContain(
        'Diagnostic (current)\nSource: eslint\nSeverity: Error\nLocation: a.ts:1:1-1:6',
      );
      expect(attachment.text).toContain('Captured source:\nvalue');
    });

    it('returns nothing when no diagnostic is chosen', async () => {
      const services = ideServices();
      services.markers.push(marker(URI.file('/workspace/a.ts')));
      services.choices.push('Diagnostic');
      expect(await createIdeContext(services).select(undefined)).toEqual([]);
    });

    it('offers the active file when no diagnostics are reported', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'value');
      services.choices.push('Diagnostic', 'Attach active file instead');
      expect(await createIdeContext(services).select(editorOf(model))).toMatchObject([
        { kind: GlyphContextAttachmentKind.FILE, text: 'value' },
      ]);
    });

    it('offers nothing when no diagnostics are reported and no editor is open', async () => {
      const services = ideServices();
      services.choices.push('Diagnostic', 'No context available');
      expect(await createIdeContext(services).select(undefined)).toEqual([]);
      expect(services.quick.pick).toHaveBeenLastCalledWith(
        [
          {
            label: 'No context available',
            detail: 'No diagnostics are reported. Diagnostic support may be unavailable.',
            attach: false,
          },
        ],
        { title: 'No diagnostics are reported. Diagnostic support may be unavailable.' },
      );
    });

    it('asks for a selection before relating symbols', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'value');
      services.choices.push('Related symbols', 'Cancel', 'Related symbols');
      const context = createIdeContext(services);
      expect(await context.select(editorOf(model, null))).toEqual([]);
      expect(await context.select(undefined)).toEqual([]);
      expect(services.quick.pick).toHaveBeenLastCalledWith(
        [{ label: 'No context available', detail: 'Select code in an editor first.', attach: false }],
        { title: 'Select code in an editor first.' },
      );
    });

    it('offers nothing for a closed editor model', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'value');
      model.dispose();
      services.choices.push('Related symbols');
      expect(await createIdeContext(services).select(editorOf(model, null))).toEqual([]);
      expect(services.quick.pick).toHaveBeenLastCalledWith(
        [{ label: 'No context available', detail: 'Select code in an editor first.', attach: false }],
        expect.anything(),
      );
    });

    it('falls back when no Git changes are available', async () => {
      const services = ideServices();
      services.choices.push('Unstaged changes');
      expect(await createIdeContext(services).select(undefined)).toEqual([]);
      expect(services.quick.pick).toHaveBeenLastCalledWith(
        [
          {
            label: 'No context available',
            detail: 'No matching Git changes are available. Git support or a repository may be unavailable.',
            attach: false,
          },
        ],
        expect.anything(),
      );
    });

    it('falls back when no terminal output is selected', async () => {
      const services = ideServices();
      services.choices.push('Terminal selection');
      expect(await createIdeContext(services).select(undefined)).toEqual([]);
      expect(services.quick.pick).toHaveBeenLastCalledWith(
        [{ label: 'No context available', detail: 'Select terminal output before attaching it.', attach: false }],
        expect.anything(),
      );
    });

    it('attaches the selection of the active terminal', async () => {
      const services = ideServices();
      services.terminals.activeInstance = {
        instanceId: 4,
        title: 'zsh',
        selection: 'done',
        capabilities: { get: () => undefined },
      };
      services.choices.push('Terminal selection');
      expect(await createIdeContext(services).select(undefined)).toMatchObject([
        { kind: GlyphContextAttachmentKind.TERMINAL, path: 'Terminal 4: zsh' },
      ]);
    });

    it('falls back when no test output is available', async () => {
      const services = ideServices();
      services.choices.push('Test output');
      expect(await createIdeContext(services).select(undefined)).toEqual([]);
      expect(services.quick.pick).toHaveBeenLastCalledWith(
        [
          {
            label: 'No context available',
            detail: 'Test output is unavailable. Run tests with a workbench test provider first.',
            attach: false,
          },
        ],
        expect.anything(),
      );
    });

    it('attaches chosen output of a completed test run', async () => {
      vi.useFakeTimers({ now: Date.UTC(2026, 0, 2) });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const services = ideServices();
      services.runs.push({ id: 'run', name: 'Run', completedAt: Date.UTC(2026, 0, 1), tasks: [testTask()] });
      let offered: readonly { label: string }[] = [];
      services.choices.push('Test output', items => {
        offered = items;
        return items[0];
      });
      const [attachment] = await createIdeContext(services).select(undefined);
      expect(offered).toMatchObject([{ label: 'Unit tests', description: 'Run', detail: 'Run run · completed' }]);
      expect(attachment).toMatchObject({
        kind: GlyphContextAttachmentKind.TEST,
        uri: 'glyph-test:/run/task',
        path: 'Test output: Unit tests',
        text: 'Test run: Run\nRun ID: run\nTask: Unit tests (task)\nController: vitest\nState: completed at 2026-01-01T00:00:00.000Z\nCaptured at: 2026-01-02T00:00:00.000Z\n\noutput',
      });
    });

    it('attaches partial output of a running test task named after its run', async () => {
      const services = ideServices();
      services.runs.push({ id: 'run', name: 'Run', tasks: [testTask({ name: '' })] });
      let offered: readonly { label: string }[] = [];
      services.choices.push('Test output', items => {
        offered = items;
        return items[0];
      });
      const [attachment] = await createIdeContext(services).select(undefined);
      expect(offered).toMatchObject([{ label: 'Run', detail: 'Run run · running (partial output)' }]);
      expect(attachment.path).toBe('Test output: Run');
      expect(attachment.text).toContain('State: running; partial output');
    });

    it('returns nothing when no test output is chosen', async () => {
      const services = ideServices();
      services.runs.push({ id: 'run', name: 'Run', tasks: [testTask()] });
      services.choices.push('Test output');
      expect(await createIdeContext(services).select(undefined)).toEqual([]);
    });

    it('refuses test output too large to attach', async () => {
      const services = ideServices();
      const getRange = vi.fn();
      services.runs.push({
        id: 'run',
        name: 'Run',
        tasks: [testTask({ output: { length: 512 * 1024 - 2047, getRange } })],
      });
      services.choices.push('Test output', items => items[0]);
      await expect(createIdeContext(services).select(undefined)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
      });
      expect(getRange).not.toHaveBeenCalled();
    });
  });

  describe('related symbols', () => {
    it('captures definitions and references of the selected code', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'alpha beta\nsecond line');
      services.languages.definitionProvider.has.mockReturnValue(true);
      services.languages.referenceProvider.has.mockReturnValue(true);
      services.languages.definitionProvider.ordered.mockReturnValue([
        { provideDefinition: async () => ({ uri: model.uri, range: new Range(2, 1, 2, 7) }) },
        { provideDefinition: async () => null },
      ]);
      services.languages.referenceProvider.ordered.mockReturnValue([
        {
          provideReferences: async () => [
            { uri: model.uri, range: new Range(2, 1, 2, 7) },
            { uri: model.uri, range: new Range(2, 8, 2, 12), targetSelectionRange: new Range(2, 8, 2, 12) },
          ],
        },
        { provideReferences: async () => undefined },
      ]);
      services.choices.push('Related symbols');
      const attachments = await createIdeContext(services).select(editorOf(model, new Range(1, 1, 1, 11)));
      expect(attachments.map(attachment => attachment.text)).toEqual([
        'Related symbols (captured from current language services)\nDefinitions: available; references: available\n0 results omitted by workspace or count limits; 0 failed queries. Up to 20 selected identifiers are queried.\nEditor revision: editor:1\n\nSelected code:\nalpha beta',
        'definition: a.ts:2:1\nEditor revision: editor:1\n\nsecond',
        'reference: a.ts:2:8\nEditor revision: editor:1\n\nline',
      ]);
    });

    it('queries at most twenty selected identifiers', async () => {
      const services = ideServices();
      const text = Array.from({ length: 25 }, (_, index) => `name${index}`).join(' ');
      const model = services.model(URI.file('/workspace/a.ts'), text);
      services.languages.definitionProvider.has.mockReturnValue(true);
      const provideDefinition = vi.fn(async () => []);
      services.languages.definitionProvider.ordered.mockReturnValue([{ provideDefinition }]);
      services.choices.push('Related symbols');
      await createIdeContext(services).select(editorOf(model, new Range(1, 1, 1, text.length + 1)));
      expect(provideDefinition).toHaveBeenCalledTimes(20);
    });

    it('marks the lookup stale when the source changed before it began', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'alpha');
      const capture = services.adapter.captureContext.getMockImplementation()!;
      services.adapter.captureContext.mockImplementationOnce(async (target, range) => {
        const attachment = await capture(target, range);
        return { ...attachment, token: { ...attachment.token!, version: 0 } };
      });
      services.languages.definitionProvider.has.mockReturnValue(true);
      const provideDefinition = vi.fn(async () => []);
      services.languages.definitionProvider.ordered.mockReturnValue([{ provideDefinition }]);
      services.choices.push('Related symbols');
      const attachments = await createIdeContext(services).select(editorOf(model));
      expect(attachments).toHaveLength(1);
      expect(attachments[0].text).toContain('stale: editor changed during lookup');
      expect(provideDefinition).not.toHaveBeenCalled();
    });

    it('skips reference queries once an edit cancels the lookup', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'alpha');
      services.languages.definitionProvider.has.mockReturnValue(true);
      services.languages.referenceProvider.has.mockReturnValue(true);
      services.languages.definitionProvider.ordered.mockReturnValue([
        {
          provideDefinition: async () => {
            model.setValue('edited');
            return [{ uri: model.uri, range: new Range(1, 1, 1, 6) }];
          },
        },
      ]);
      services.languages.referenceProvider.ordered.mockReturnValue([
        { provideReferences: async () => [{ uri: model.uri, range: new Range(1, 1, 1, 6) }] },
      ]);
      services.choices.push('Related symbols');
      const attachments = await createIdeContext(services).select(editorOf(model));
      expect(attachments).toHaveLength(1);
      expect(attachments[0].text).toContain('stale: editor changed during lookup');
      expect(services.resolver.createModelReference).not.toHaveBeenCalled();
    });

    it('omits results beyond twenty and outside of the workspace', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'alpha '.repeat(5));
      services.languages.definitionProvider.has.mockReturnValue(true);
      services.languages.definitionProvider.ordered.mockReturnValue([
        {
          provideDefinition: async () => [
            { uri: URI.file('/elsewhere/b.ts'), range: new Range(1, 1, 1, 2) },
            ...Array.from({ length: 21 }, (_, index) => ({
              uri: model.uri,
              range: new Range(1, index + 1, 1, index + 2),
            })),
          ],
        },
      ]);
      services.choices.push('Related symbols');
      const attachments = await createIdeContext(services).select(editorOf(model));
      expect(attachments).toHaveLength(21);
      expect(attachments[0].text).toContain('2 results omitted by workspace or count limits');
    });

    it('discards results when a related document changes during capture', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'alpha');
      const target = services.model(URI.file('/workspace/b.ts'), 'beta');
      const capture = services.adapter.captureContext.getMockImplementation()!;
      services.adapter.captureContext.mockImplementation(async (source, range) => {
        if (source === target) target.setValue('changed');
        return capture(source, range);
      });
      services.languages.definitionProvider.has.mockReturnValue(true);
      services.languages.definitionProvider.ordered.mockReturnValue([
        { provideDefinition: async () => [{ uri: target.uri, range: new Range(1, 1, 1, 5) }] },
      ]);
      services.choices.push('Related symbols');
      const attachments = await createIdeContext(services).select(editorOf(model));
      expect(attachments).toHaveLength(1);
      expect(attachments[0].text).toContain('stale: editor changed during lookup');
    });

    it('reports a language-service timeout as partial', async () => {
      vi.useFakeTimers();
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'alpha');
      services.languages.definitionProvider.has.mockReturnValue(true);
      const queried = Promise.withResolvers<void>();
      services.languages.definitionProvider.ordered.mockReturnValue([
        {
          provideDefinition: () => {
            queried.resolve();
            return new Promise(() => {});
          },
        },
      ]);
      services.choices.push('Related symbols');
      const selecting = createIdeContext(services).select(editorOf(model));
      await queried.promise;
      await vi.advanceTimersByTimeAsync(5000);
      const attachments = await selecting;
      expect(attachments).toHaveLength(1);
      expect(attachments[0].text).toContain('Related symbols (partial: language-service timeout)');
    });

    it('reports failed reference queries as partial', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'alpha');
      services.languages.referenceProvider.has.mockReturnValue(true);
      services.languages.referenceProvider.ordered.mockReturnValue([
        {
          provideReferences: async () => {
            throw new Error('Provider stopped');
          },
        },
      ]);
      services.choices.push('Related symbols');
      const [summary] = await createIdeContext(services).select(editorOf(model));
      expect(summary.text).toContain(
        'Related symbols (partial: language-service queries failed)\nDefinitions: unavailable; references: available\n0 results omitted by workspace or count limits; 2 failed queries.',
      );
    });

    it('offers the active file when language services are unavailable', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'alpha');
      services.choices.push('Related symbols', 'Attach active file instead');
      expect(await createIdeContext(services).select(editorOf(model))).toMatchObject([
        { kind: GlyphContextAttachmentKind.FILE, text: 'alpha' },
      ]);
    });

    it('labels import declarations of selected identifiers as lexical matches', async () => {
      const services = ideServices();
      const model = services.model(
        URI.file('/workspace/a.ts'),
        "import { alpha } from './alpha';\nconst other = require('other');\nalpha();",
        'typescript',
      );
      services.languages.definitionProvider.has.mockReturnValue(true);
      services.languages.definitionProvider.ordered.mockReturnValue([{ provideDefinition: async () => [] }]);
      services.choices.push('Related symbols');
      const attachments = await createIdeContext(services).select(editorOf(model, new Range(3, 1, 3, 6)));
      expect(attachments.map(attachment => attachment.text)).toEqual([
        expect.stringContaining('captured from current language services'),
        "Import declaration (lexical match): a.ts:1\nEditor revision: editor:1\n\nimport { alpha } from './alpha';",
      ]);
    });
  });

  describe('Git changes', () => {
    function repository(resources: unknown[], { providerId = 'git', group = 'index' } = {}) {
      return { provider: { providerId, name: 'repo', groups: [{ id: group, resources }] } };
    }

    it('attaches the staged change of a chosen file', async () => {
      const services = ideServices();
      const head = URI.from({
        scheme: 'git',
        path: '/workspace/a.ts',
        query: JSON.stringify({ path: '/workspace/a.ts', ref: 'HEAD' }),
      });
      const index = URI.from({
        scheme: 'git',
        path: '/workspace/a.ts',
        query: JSON.stringify({ path: '/workspace/a.ts', ref: '' }),
      });
      services.model(head, 'one\n');
      services.model(index, 'two');
      services.scm.repositories.push(
        repository([{ sourceUri: URI.file('/workspace/a.ts') }], { providerId: 'hg' }),
        repository([
          {
            sourceUri: URI.file('/workspace/a.ts'),
            multiDiffEditorOriginalUri: head,
            multiDiffEditorModifiedUri: index,
          },
        ]),
      );
      let offered: readonly { label: string }[] = [];
      services.choices.push('Staged changes', items => {
        offered = items;
        return items[0];
      });
      const [attachment] = await createIdeContext(services).select(undefined);
      expect(offered).toMatchObject([{ label: 'a.ts', description: 'repo' }]);
      expect(attachment).toMatchObject({
        kind: GlyphContextAttachmentKind.DIFF,
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
      });
      expect(attachment.text).toContain(
        `Git diff: HEAD → index\nBase URI: ${head.toString()}\nTarget URI: ${index.toString()}`,
      );
      expect(attachment.text).toContain(
        '--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-one\n+two\n\\ No newline at end of file\n',
      );
    });

    it('compares unstaged changes against the index', async () => {
      const services = ideServices();
      const head = URI.from({
        scheme: 'git',
        path: '/workspace/a.ts',
        query: JSON.stringify({ path: '/workspace/a.ts', ref: 'HEAD' }),
      });
      const index = URI.from({
        scheme: 'git',
        path: '/workspace/a.ts',
        query: JSON.stringify({ path: '/workspace/a.ts', ref: '' }),
      });
      services.model(index, 'staged\n');
      services.model(URI.file('/workspace/a.ts'), 'working\n');
      services.scm.repositories.push(
        repository(
          [
            {
              sourceUri: URI.file('/workspace/a.ts'),
              multiDiffEditorOriginalUri: head,
              multiDiffEditorModifiedUri: URI.file('/workspace/a.ts'),
            },
          ],
          { group: 'workingTree' },
        ),
      );
      services.choices.push('Unstaged changes', items => items[0]);
      const [attachment] = await createIdeContext(services).select(undefined);
      expect(attachment.text).toContain(
        `Git diff: index → working tree (includes unsaved editor text)\nBase URI: ${index.toString()}`,
      );
      expect(attachment.text).toContain('-staged\n+working\n');
    });

    it('keeps the base of an unstaged submodule change', async () => {
      const services = ideServices();
      const base = URI.from({
        scheme: 'git',
        path: '/workspace/sub',
        query: JSON.stringify({ path: '/workspace/sub', ref: 'HEAD', submoduleOf: '/workspace' }),
      });
      services.model(base, 'Subproject commit 1\n');
      services.scm.repositories.push(
        repository([{ sourceUri: URI.file('/workspace/sub'), multiDiffEditorOriginalUri: base }], {
          group: 'workingTree',
        }),
      );
      services.choices.push('Unstaged changes', items => items[0]);
      const [attachment] = await createIdeContext(services).select(undefined);
      expect(attachment.text).toContain(`Base URI: ${base.toString()}\nTarget URI: /dev/null`);
      expect(attachment.text).toContain('--- sub\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-Subproject commit 1\n');
    });

    it('returns nothing when no change is chosen', async () => {
      const services = ideServices();
      services.scm.repositories.push(repository([{ sourceUri: URI.file('/workspace/a.ts') }]));
      services.choices.push('Staged changes');
      expect(await createIdeContext(services).select(undefined)).toEqual([]);
    });

    it('falls back when the provider exposes no diff resources', async () => {
      const services = ideServices();
      services.scm.repositories.push(repository([{ sourceUri: URI.file('/workspace/a.ts') }]));
      services.choices.push('Staged changes', items => items[0]);
      expect(await createIdeContext(services).select(undefined)).toEqual([]);
      expect(services.quick.pick).toHaveBeenLastCalledWith(
        [
          {
            label: 'No context available',
            detail: 'This Git provider does not expose explicit diff resources.',
            attach: false,
          },
        ],
        expect.anything(),
      );
    });
  });

  describe(GlyphIdeContext.prototype.captureDiff, () => {
    it('captures an added file and reports the compared text', async () => {
      const services = ideServices();
      const after = services.model(URI.file('/workspace/a.ts'), 'one\ntwo\n');
      const captured = vi.fn();
      const attachment = await createIdeContext(services).captureDiff(
        URI.file('/workspace/a.ts').with({ query: 'q', fragment: 'f' }),
        undefined,
        after.uri,
        'HEAD → index',
        captured,
      );
      expect(captured).toHaveBeenCalledWith('', 'one\ntwo\n');
      expect(attachment).toMatchObject({ uri: 'file:///workspace/a.ts', path: 'a.ts' });
      expect(attachment.text).toContain('Base URI: /dev/null');
      expect(attachment.text).toContain('--- /dev/null\n+++ a.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n');
    });

    it('refuses comparison resources that are neither files nor Git revisions', async () => {
      const services = ideServices();
      await expect(
        createIdeContext(services).captureDiff(
          URI.file('/workspace/a.ts'),
          URI.parse('http://example.com/a.ts'),
          undefined,
          'HEAD → index',
        ),
      ).rejects.toMatchObject({ code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE });
    });

    it('refuses a comparison too large to attach', async () => {
      const services = ideServices();
      const after = services.model(URI.file('/workspace/a.ts'), 'x'.repeat(256 * 1024 + 1));
      await expect(
        createIdeContext(services).captureDiff(after.uri, undefined, after.uri, 'HEAD → index'),
      ).rejects.toMatchObject({ code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED });
    });

    it('refuses a comparison that changes while it is captured', async () => {
      const services = ideServices();
      const after = services.model(URI.file('/workspace/a.ts'), 'one');
      const resolve = services.resolver.createModelReference.getMockImplementation()!;
      services.resolver.createModelReference.mockImplementation(async uri => {
        const reference = await resolve(uri);
        if (services.resolver.createModelReference.mock.calls.length === 2) after.setValue('two');
        return reference;
      });
      await expect(
        createIdeContext(services).captureDiff(after.uri, undefined, after.uri, 'HEAD → index'),
      ).rejects.toMatchObject({ code: GlyphDesktopErrorCode.STALE_DOCUMENT });
    });
  });

  describe(GlyphIdeContext.prototype.captureDiagnostic, () => {
    it.each([
      [{ modelVersionId: 9 }, 'stale: diagnostic no longer matches the editor; captured message is historical'],
      [{ modelVersionId: undefined }, 'freshness unknown: provider did not report a model version'],
    ])('labels the freshness of a diagnostic reported %j', async (overrides, status) => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'value');
      const diagnostic = marker(model.uri, overrides);
      services.markers.push(diagnostic);
      const [attachment] = await createIdeContext(services).captureDiagnostic(diagnostic);
      expect(attachment.text).toContain(`Diagnostic (${status})\nSource: typescript\n`);
    });

    it('labels a diagnostic that is no longer reported as stale', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'value');
      const [attachment] = await createIdeContext(services).captureDiagnostic(marker(model.uri, { modelVersionId: 1 }));
      expect(attachment.text).toContain('Diagnostic (stale: diagnostic no longer matches the editor;');
    });

    it('refuses a capture whose workspace path changed meanwhile', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'value');
      const capture = services.adapter.captureContext.getMockImplementation()!;
      services.adapter.captureContext.mockImplementation(async (target, range) => ({
        ...(await capture(target, range)),
        path: 'renamed.ts',
      }));
      await expect(createIdeContext(services).captureDiagnostic(marker(model.uri))).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.STALE_DOCUMENT,
      });
    });
  });

  describe(GlyphIdeContext.prototype.captureTestSelection, () => {
    it('refuses a selection whose test run is gone', async () => {
      const services = ideServices();
      const model = services.model(
        buildTestUri({ type: TestUriType.TaskOutput, resultId: 'gone', taskIndex: 0 }),
        'output',
      );
      await expect(createIdeContext(services).captureTestSelection(model, new Range(1, 1, 1, 7))).rejects.toMatchObject(
        {
          code: GlyphDesktopErrorCode.NOT_FOUND,
        },
      );
    });

    it('refuses a selection outside of test output', async () => {
      const services = ideServices();
      const model = services.model(URI.file('/workspace/a.ts'), 'output');
      await expect(createIdeContext(services).captureTestSelection(model, new Range(1, 1, 1, 7))).rejects.toMatchObject(
        {
          code: GlyphDesktopErrorCode.NOT_FOUND,
        },
      );
    });

    it('names a selection from an unnamed task after its run', async () => {
      const services = ideServices();
      services.runs.push({ id: 'run', name: 'Run', tasks: [testTask({ name: '' })] });
      const model = services.model(
        buildTestUri({ type: TestUriType.TaskOutput, resultId: 'run', taskIndex: 0 }),
        'output',
      );
      expect(await createIdeContext(services).captureTestSelection(model, new Range(1, 1, 1, 4))).toMatchObject({
        kind: GlyphContextAttachmentKind.TEST,
        path: 'Test output: Run',
        sourceRevision: 'run:task:1',
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
        text: 'Test run: Run\nRun ID: run\nTask:  (task)\nController: vitest\nEditor version: 1\nSelected lines: 1-1\n\nSelected test output:\nout',
      });
    });
  });

  describe(GlyphIdeContext.prototype.captureTestFailure, () => {
    function failureRun(message: object, item: object = { label: 'adds' }, completedAt?: number): TestRun {
      return {
        id: 'run',
        name: 'Run',
        completedAt,
        tasks: [testTask()],
        getStateById: id => (id === 'test' ? { item, tasks: [{ messages: [message] }] } : undefined),
      };
    }

    function failureModel(services: IdeServices) {
      return services.model(
        buildTestUri({
          type: TestUriType.ResultMessage,
          resultId: 'run',
          testExtId: 'test',
          taskIndex: 0,
          messageIndex: 0,
        }),
        'failure message',
      );
    }

    it('refuses a failure that is no longer recorded', async () => {
      const services = ideServices();
      services.runs.push(failureRun({ message: 'failed' }));
      await expect(createIdeContext(services).captureTestFailure('run', 'other', 0, 0)).rejects.toThrow(
        'The selected test failure is no longer available. Run the test again.',
      );
    });

    it('captures a completed failure with its location and comparison', async () => {
      const services = ideServices();
      failureModel(services);
      services.runs.push(
        failureRun(
          {
            message: 'failed',
            expected: '1',
            actual: '2',
            location: { uri: URI.file('/workspace/a.ts'), range: new Range(3, 1, 3, 4) },
          },
          { label: 'adds' },
          1,
        ),
      );
      const [attachment] = await createIdeContext(services).captureTestFailure('run', 'test', 0, 0);
      expect(attachment.text).toMatch(
        /^Test: adds \(test\)\nSource: file:\/\/\/workspace\/a\.ts:3\nRun state: completed\n\nExpected: 1\nActual: 2\n\nTest run: Run\n/,
      );
    });

    it('describes a running failure by its test item and missing expectation', async () => {
      const services = ideServices();
      failureModel(services);
      services.runs.push(
        failureRun({ message: 'failed', actual: undefined }, { label: 'adds', uri: URI.file('/workspace/a.test.ts') }),
      );
      const [attachment] = await createIdeContext(services).captureTestFailure('run', 'test', 0, 0);
      expect(attachment.text).toMatch(
        /^Test: adds \(test\)\nSource: file:\/\/\/workspace\/a\.test\.ts\nRun state: running \(partial\)\n\nExpected: unavailable\nActual: unavailable\n\n/,
      );
    });

    it('describes a failure without a source or actual output', async () => {
      const services = ideServices();
      failureModel(services);
      services.runs.push(failureRun({ message: 'failed', expected: '1' }));
      const [attachment] = await createIdeContext(services).captureTestFailure('run', 'test', 0, 0);
      expect(attachment.text).toMatch(
        /^Test: adds \(test\)\nSource: unavailable\n.*\n\nExpected: 1\nActual: unavailable\n/,
      );
    });

    it('omits the comparison of a plain failure message', async () => {
      const services = ideServices();
      failureModel(services);
      services.runs.push(failureRun({ message: 'failed' }));
      const [attachment] = await createIdeContext(services).captureTestFailure('run', 'test', 0, 0);
      expect(attachment.text).toMatch(
        /^Test: adds \(test\)\nSource: unavailable\nRun state: running \(partial\)\n\nTest run: Run/,
      );
    });
  });

  describe(GlyphIdeContext.prototype.terminal, () => {
    function terminalInstance(commands: unknown[] | undefined, selection = { start: { y: 4 }, end: { y: 5 } }) {
      return {
        instanceId: 7,
        title: 'Tests',
        selection: 'selected output',
        xterm: { raw: { getSelectionPosition: () => selection } },
        capabilities: {
          get: (capability: TerminalCapability) =>
            capability === TerminalCapability.CommandDetection && commands ? { commands } : undefined,
        },
      };
    }

    function command(name: string, executed: number, end: number, overrides: object = {}) {
      return {
        command: name,
        cwd: '/workspace',
        marker: { line: executed - 1 },
        executedMarker: { line: executed },
        endMarker: { line: end },
        ...overrides,
      };
    }

    it('attributes a selection to the one command that produced it', async () => {
      const services = ideServices();
      const [attachment] = await createIdeContext(services).terminal(
        terminalInstance([command('pnpm test', 3, 6), command('ls', 7, 9)]) as never,
      );
      expect(attachment.text).toContain(
        'Terminal: Tests\nInstance: 7\nCommand: pnpm test\nWorking directory: /workspace\n',
      );
    });

    it.each([
      ['overlaps several commands', [command('pnpm test', 3, 6), command('pnpm lint', 2, 8)]],
      ['spans past a command', [command('pnpm test', 5, 6)]],
      ['ends after a command', [command('pnpm test', 3, 4)]],
      ['comes from an incomplete command', [command('pnpm test', 3, 6, { endMarker: undefined })]],
      ['comes from a command that never ran', [command('pnpm test', 3, 6, { executedMarker: undefined })]],
      ['comes from an unmarked command', [command('pnpm test', 3, 6, { marker: undefined })]],
    ])('does not attribute a selection that %s', async (_case, commands) => {
      const services = ideServices();
      const [attachment] = await createIdeContext(services).terminal(terminalInstance(commands) as never);
      expect(attachment.text).toContain(
        'Command: unavailable: selection cannot be attributed to one detected command\nWorking directory: unavailable\n',
      );
    });

    it('does not attribute a selection without a known position', async () => {
      const services = ideServices();
      const instance = { ...terminalInstance([command('pnpm test', 3, 6)]), xterm: undefined };
      const [attachment] = await createIdeContext(services).terminal(instance as never);
      expect(attachment.text).toContain('Command: unavailable');
    });

    it('does not attribute a selection without command detection', async () => {
      const services = ideServices();
      const [attachment] = await createIdeContext(services).terminal(terminalInstance(undefined) as never);
      expect(attachment.text).toContain('Command: unavailable');
    });

    it('refuses a selection too large to attach', async () => {
      const services = ideServices();
      const instance = { ...terminalInstance(undefined), selection: 'x'.repeat(512 * 1024) };
      await expect(createIdeContext(services).terminal(instance as never)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
      });
    });

    it('refuses a capture when trust is revoked while hashing', async () => {
      const services = ideServices();
      services.trust.isWorkspaceTrusted.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
      await expect(createIdeContext(services).terminal(terminalInstance(undefined) as never)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
      });
    });
  });

  describe(GlyphIdeContext.prototype.openSource, () => {
    it('focuses the terminal of a captured selection', async () => {
      const services = ideServices();
      const focusWhenReady = vi.fn(async () => {});
      const instance = {
        instanceId: 7,
        title: 'Tests',
        selection: 'output',
        capabilities: { get: () => undefined },
        focusWhenReady,
      };
      services.terminals.getInstanceFromId.mockImplementation(id => (id === 7 ? instance : undefined));
      const context = createIdeContext(services);
      const [attachment] = await context.terminal(instance as never);
      expect(await context.openSource(URI.parse(attachment.uri), {} as never)).toBe(true);
      expect(services.terminals.setActiveInstance).toHaveBeenCalledWith(instance);
      expect(services.terminals.revealActiveTerminal).toHaveBeenCalledOnce();
      expect(focusWhenReady).toHaveBeenCalledWith(true);
    });

    it('refuses a terminal that has closed or was never captured', async () => {
      const services = ideServices();
      const instance = { instanceId: 7, title: 'Tests', selection: 'output', capabilities: { get: () => undefined } };
      const context = createIdeContext(services);
      const [attachment] = await context.terminal(instance as never);
      for (const uri of [attachment.uri, 'glyph-terminal:/unknown/7'])
        await expect(context.openSource(URI.parse(uri), {} as never)).rejects.toMatchObject({
          code: GlyphDesktopErrorCode.NOT_FOUND,
          message: 'Terminal closed. The captured output is preserved.',
        });
      expect(services.terminals.getInstanceFromId).toHaveBeenCalledOnce();
    });

    it.each([
      URI.from({ scheme: 'vscode-test-data', authority: 'results', path: '/run/unknown' }),
      buildTestUri({ type: TestUriType.TaskOutput, resultId: 'gone', taskIndex: 0 }),
      buildTestUri({ type: TestUriType.TaskOutput, resultId: 'run', taskIndex: 3 }),
      URI.parse('glyph-test:/gone/task'),
      URI.parse('glyph-test:/run/gone'),
    ])('refuses test output that is unavailable at %s', async uri => {
      const services = ideServices();
      services.runs.push({ id: 'run', name: 'Run', tasks: [testTask()] });
      const editors = { openEditor: vi.fn() };
      await expect(createIdeContext(services).openSource(uri, editors as never)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.NOT_FOUND,
        message: 'Test run unavailable. The captured output is preserved.',
      });
      expect(editors.openEditor).not.toHaveBeenCalled();
    });

    it.each([
      [
        buildTestUri({ type: TestUriType.TaskOutput, resultId: 'run', taskIndex: 0 }),
        'vscode-test-data://results/run/output/0',
      ],
      [URI.parse('glyph-test:/run/task'), 'vscode-test-data://results/run/output/0'],
    ])('opens test output at %s', async (uri, resource) => {
      const services = ideServices();
      services.runs.push({ id: 'run', name: 'Run', tasks: [testTask()] });
      const editors = { openEditor: vi.fn() };
      const context = createIdeContext(services);
      expect(await context.openSource(uri, editors as never)).toBe(true);
      expect(
        await context.openSource(uri, editors as never, { start: { line: 1, column: 2 }, end: { line: 3, column: 4 } }),
      ).toBe(true);
      expect(editors.openEditor.mock.calls.map(([input]) => [input.resource.toString(), input.options])).toEqual([
        [resource, { pinned: true }],
        [resource, { pinned: true, selection: { startLineNumber: 1, startColumn: 2, endLineNumber: 3, endColumn: 4 } }],
      ]);
    });

    it('leaves other sources to the caller', async () => {
      expect(await createIdeContext(ideServices()).openSource(URI.file('/workspace/a.ts'), {} as never)).toBe(false);
    });
  });
});
