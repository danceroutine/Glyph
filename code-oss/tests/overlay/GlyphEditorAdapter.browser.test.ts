import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { GlyphEditorAdapter } from '#vs/workbench/contrib/glyph/browser/GlyphEditorAdapter.js';
import { URI } from '#vs/base/common/uri.js';
import { Emitter } from '#vs/base/common/event.js';
import { VSBuffer } from '#vs/base/common/buffer.js';
import { FileOperationError, FileOperationResult } from '#vs/platform/files/common/files.js';
import { TextFileOperationError, TextFileOperationResult } from '#vs/workbench/services/textfile/common/textfiles.js';
import { ResourceFileEdit, ResourceTextEdit } from '#vs/editor/browser/services/bulkEditService.js';
import { EndOfLineSequence } from '#vs/editor/common/model.js';
import { createTextModel } from '#vs/editor/test/common/testTextModel.js';
import { GlyphEditorRequestType } from '#glyph/protocol/editor/GlyphEditorRequest.js';
import { GlyphFileMutationKind, type GlyphFileMutation } from '#glyph/protocol/editor/GlyphFileMutation.js';
import { GlyphMutationReceiptState } from '#glyph/protocol/editor/GlyphMutationReceipt.js';
import { GlyphWorkingCopyPatternKind } from '#glyph/protocol/editor/GlyphWorkingCopySearchOptions.js';
import type { GlyphEditorTextSnapshot } from '#glyph/protocol/editor/GlyphEditorTextSnapshot.js';
import type { GlyphTextMutation } from '#glyph/protocol/editor/GlyphTextMutation.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';

interface ContentChange {
  readonly detailedReasons: readonly unknown[];
  readonly isEolChange: boolean;
}

function textModel(resource: URI, initial: string, { eol = '\n', byteOrderMark = false } = {}) {
  const changes = new Emitter<ContentChange>();
  const model = {
    uri: resource,
    text: initial,
    eol,
    byteOrderMark,
    version: 1,
    getVersionId: () => model.version,
    getValue: (_eol?: unknown, preserveBOM?: boolean) =>
      `${preserveBOM === true && model.byteOrderMark ? '\uFEFF' : ''}${model.text}`,
    getValueLength: () => model.text.length,
    getEOL: () => model.eol,
    getFullModelRange: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: model.text.length + 1,
    }),
    onDidChangeContent: changes.event,
    notify: (change: ContentChange) => {
      changes.fire(change);
    },
    write: (text: string, detailedReasons: readonly unknown[] = [], isEolChange = false) => {
      model.text = text;
      model.version++;
      changes.fire({ detailedReasons, isEolChange });
    },
  };
  return model;
}

type TextModelFake = ReturnType<typeof textModel>;
type BulkEdit = ResourceTextEdit | ResourceFileEdit;
type BulkOptions = { reason?: unknown };

function editorServices() {
  const folderChanges = new Emitter<void>();
  const nameChanges = new Emitter<void>();
  const stateChanges = new Emitter<void>();
  const profileChanges = new Emitter<void>();
  const workspace = {
    id: 'workspace',
    configuration: undefined as URI | undefined,
    folders: [{ name: 'workspace', uri: URI.file('/workspace') }],
  };
  const state = { trusted: true, profile: 'profile' };
  const models: TextModelFake[] = [];
  const disk = new Map<string, string>();
  const dirty = new Set<string>();
  const find = (resource: URI) => models.find(model => model.uri.toString() === resource.toString());
  const inside = (resource: URI) =>
    workspace.folders.find(folder => resource.path.startsWith(`${folder.uri.path}/`)) ?? null;
  const writeText = (edit: ResourceTextEdit, reason: unknown) => {
    const model = find(edit.resource)!;
    const { range, text, eol } = edit.textEdit;
    const empty = range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
    if (!(empty && !text) && model.text !== text.replaceAll(/\r\n|\r|\n/gu, model.eol)) {
      model.write(text.replaceAll(/\r\n|\r|\n/gu, model.eol), [reason]);
      dirty.add(model.uri.path);
    }
    if (eol !== undefined) {
      const next = eol === EndOfLineSequence.CRLF ? '\r\n' : '\n';
      if (next !== model.eol) {
        model.eol = next;
        model.write(model.text.replaceAll(/\r\n|\r|\n/gu, next), [], true);
      }
    }
  };
  const writeFile = async (edit: ResourceFileEdit) => {
    if (!edit.oldResource) {
      disk.set(edit.newResource!.path, (await edit.options.contents!).toString());
      return;
    }
    if (edit.newResource) disk.set(edit.newResource.path, disk.get(edit.oldResource.path)!);
    disk.delete(edit.oldResource.path);
    models.splice(models.indexOf(find(edit.oldResource)!), 1);
  };
  const services = {
    state,
    workspace,
    models,
    disk,
    dirty,
    folderChanges,
    nameChanges,
    stateChanges,
    profileChanges,
    writeText,
    open: (path: string, text: string, options?: { eol?: string; byteOrderMark?: boolean }) => {
      const model = textModel(URI.file(`/workspace/${path}`), text, options);
      models.push(model);
      disk.set(model.uri.path, text);
      return model;
    },
    textModelService: {
      createModelReference: vi.fn(async (resource: URI) => {
        let model = find(resource);
        if (!model) {
          const text = disk.get(resource.path);
          if (text === undefined) throw new FileOperationError('Missing file', FileOperationResult.FILE_NOT_FOUND);
          model = textModel(resource, text.replace(/^\uFEFF/u, ''), { byteOrderMark: text.startsWith('\uFEFF') });
          models.push(model);
        }
        return { object: { textEditorModel: model }, dispose: vi.fn() };
      }),
    },
    bulkEditService: {
      apply: vi.fn(async (edits: readonly BulkEdit[], options: BulkOptions) => {
        for (const edit of edits)
          if (edit instanceof ResourceTextEdit) writeText(edit, options.reason);
          else await writeFile(edit);
        return { isApplied: true };
      }),
    },
    workspaceContextService: {
      getWorkspace: () => workspace,
      getWorkspaceFolder: inside,
      isInsideWorkspace: (resource: URI) => inside(resource) !== null,
      onDidChangeWorkspaceFolders: folderChanges.event,
      onDidChangeWorkspaceName: nameChanges.event,
      onDidChangeWorkbenchState: stateChanges.event,
    },
    modelService: {
      getModels: () => models,
      getModel: vi.fn((resource: URI) => find(resource) ?? null),
    },
    textFileService: {
      isDirty: vi.fn((resource: URI) => dirty.has(resource.path)),
      save: vi.fn(async (resource: URI): Promise<URI | undefined> => {
        disk.set(resource.path, find(resource)!.text);
        dirty.delete(resource.path);
        return resource;
      }),
    },
    trustService: { isWorkspaceTrusted: vi.fn(() => state.trusted) },
    fileService: {
      exists: vi.fn(async (resource: URI) => disk.has(resource.path)),
      stat: vi.fn(async (resource: URI): Promise<{ size?: number }> => ({ size: disk.get(resource.path)?.length })),
      readFile: vi.fn(async (resource: URI) => ({ value: VSBuffer.fromString(disk.get(resource.path) ?? '') })),
    },
    uriIdentityService: { asCanonicalUri: (resource: URI) => resource },
    userDataProfileService: {
      get currentProfile() {
        return { id: state.profile };
      },
      onDidChangeCurrentProfile: profileChanges.event,
    },
    instantiationService: { createInstance: vi.fn() },
  };
  return services;
}

type EditorServices = ReturnType<typeof editorServices>;

function createAdapter(services: EditorServices) {
  const adapter = new GlyphEditorAdapter(
    services.textModelService as never,
    services.bulkEditService as never,
    services.workspaceContextService as never,
    services.modelService as never,
    services.textFileService as never,
    services.trustService as never,
    services.fileService as never,
    services.uriIdentityService as never,
    services.userDataProfileService as never,
    services.instantiationService as never,
  );
  onTestFinished(() => {
    adapter.dispose();
  });
  return adapter;
}

function textMutation(
  snapshot: GlyphEditorTextSnapshot,
  text: string,
  overrides: Partial<GlyphTextMutation> = {},
): GlyphTextMutation {
  return {
    operationId: 'edit',
    path: snapshot.path,
    text,
    byteOrderMark: snapshot.byteOrderMark,
    undoGroupId: 'group',
    expectedContentRevision: snapshot.contentRevision,
    expectedToken: snapshot.token,
    ...overrides,
  };
}

function fileMutation(
  snapshot: GlyphEditorTextSnapshot,
  kind: GlyphFileMutationKind.DELETE | GlyphFileMutationKind.RENAME,
  overrides: { operationId?: string; target?: string; save?: boolean } = {},
): GlyphFileMutation {
  return {
    operationId: 'file',
    undoGroupId: 'group',
    path: snapshot.path,
    kind,
    expectedContentRevision: snapshot.contentRevision,
    expectedToken: snapshot.token,
    ...overrides,
  };
}

function applyText(adapter: GlyphEditorAdapter, mutation: GlyphTextMutation) {
  return adapter.handle({ type: GlyphEditorRequestType.APPLY_TEXT_MUTATION, mutation });
}

function applyFile(adapter: GlyphEditorAdapter, mutation: GlyphFileMutation) {
  return adapter.handle({ type: GlyphEditorRequestType.APPLY_FILE_MUTATION, mutation });
}

function readSnapshot(adapter: GlyphEditorAdapter, path: string) {
  return adapter.handle({ type: GlyphEditorRequestType.READ_SNAPSHOT, operationId: 'read', path });
}

function failure(code: GlyphDesktopErrorCode) {
  return { ok: false, error: { code } };
}

describe(GlyphEditorAdapter, () => {
  it('rejects requests once a session change alters the workspace binding', async () => {
    const services = editorServices();
    services.open('a.ts', 'text');
    const adapter = createAdapter(services);
    services.workspace.id = 'other';
    services.nameChanges.fire();
    services.stateChanges.fire();
    expect(await readSnapshot(adapter, 'a.ts')).toMatchObject(failure(GlyphDesktopErrorCode.WORKSPACE_CHANGED));
  });

  it('keeps serving requests when a session event leaves the binding intact', async () => {
    const services = editorServices();
    services.open('a.ts', 'text');
    const adapter = createAdapter(services);
    services.profileChanges.fire();
    expect(await readSnapshot(adapter, 'a.ts')).toMatchObject({ ok: true, snapshot: { text: 'text' } });
  });

  it('rejects requests when the workspace binding changes without notice', async () => {
    const services = editorServices();
    const adapter = createAdapter(services);
    services.state.profile = 'other';
    expect(
      await adapter.handle({ type: GlyphEditorRequestType.EXISTS, operationId: 'exists', path: 'a.ts' }),
    ).toMatchObject(failure(GlyphDesktopErrorCode.WORKSPACE_CHANGED));
  });

  it('serves requests again after rebinding to changed folders', async () => {
    const services = editorServices();
    services.open('a.ts', 'text');
    const adapter = createAdapter(services);
    services.folderChanges.fire();
    expect(await readSnapshot(adapter, 'a.ts')).toMatchObject(failure(GlyphDesktopErrorCode.WORKSPACE_CHANGED));
    adapter.rebindWorkspace();
    expect(await readSnapshot(adapter, 'a.ts')).toMatchObject({ ok: true });
  });

  it('releases the documents it holds when disposed', async () => {
    const services = editorServices();
    services.open('a.ts', 'text');
    const adapter = createAdapter(services);
    await adapter.read('a.ts');
    const reference = (await services.textModelService.createModelReference.mock.results[0].value) as { dispose: Mock };
    adapter.dispose();
    expect(reference.dispose).toHaveBeenCalledOnce();
  });

  describe(GlyphEditorAdapter.prototype.handle, () => {
    it('refuses editor requests in an untrusted workspace', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      services.state.trusted = false;
      expect(await readSnapshot(adapter, 'a.ts')).toMatchObject(failure(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE));
    });

    it('lists the working copies of workspace files', async () => {
      const services = editorServices();
      services.open('a.ts', 'alpha');
      services.models.push(textModel(URI.from({ scheme: 'untitled', path: 'Untitled-1' }), 'draft'));
      services.models.push(textModel(URI.file('/elsewhere/b.ts'), 'outside'));
      const adapter = createAdapter(services);
      const response = await adapter.handle({ type: GlyphEditorRequestType.LIST_WORKING_COPIES, operationId: 'list' });
      expect(response).toMatchObject({ ok: true, workingCopies: [{ path: 'a.ts', text: 'alpha', dirty: false }] });
      expect(
        await adapter.handle({ type: GlyphEditorRequestType.LIST_WORKING_COPY_PATHS, operationId: 'paths' }),
      ).toMatchObject({ ok: true, workingCopyPaths: ['a.ts'] });
    });

    it('prefixes working copy paths with their root in a multi-root workspace', async () => {
      const services = editorServices();
      services.workspace.folders = [
        { name: 'one', uri: URI.file('/one') },
        { name: 'two', uri: URI.file('/two') },
      ];
      services.models.push(textModel(URI.file('/two/b.ts'), 'beta'));
      const adapter = createAdapter(services);
      expect(
        await adapter.handle({ type: GlyphEditorRequestType.LIST_WORKING_COPY_PATHS, operationId: 'paths' }),
      ).toMatchObject({ ok: true, workingCopyPaths: ['two/b.ts'] });
      expect(await adapter.read('two/b.ts')).toMatchObject({ path: 'two/b.ts', text: 'beta' });
    });

    it('refuses to list more than 2000 working copies', async () => {
      const services = editorServices();
      for (let index = 0; index <= 2000; index++) services.open(`file-${index}.ts`, '');
      const adapter = createAdapter(services);
      expect(
        await adapter.handle({ type: GlyphEditorRequestType.LIST_WORKING_COPY_PATHS, operationId: 'paths' }),
      ).toMatchObject({
        ok: false,
        error: {
          code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
          details: { maximumWorkingCopies: 2000, workingCopies: 2001 },
        },
      });
    });

    it('searches working copies for literal text regardless of case', async () => {
      const services = editorServices();
      services.open('a.ts', 'first A.b line\nsecond a.B line');
      const adapter = createAdapter(services);
      expect(
        await adapter.handle({
          type: GlyphEditorRequestType.SEARCH_WORKING_COPIES,
          operationId: 'search',
          pattern: 'a.b',
          options: {
            patternKind: GlyphWorkingCopyPatternKind.LITERAL,
            caseSensitive: false,
            multiline: false,
            limit: 10,
          },
        }),
      ).toEqual({
        operationId: 'search',
        ok: true,
        search: {
          truncated: false,
          matches: [
            {
              path: 'a.ts',
              line: 1,
              column: 7,
              endLine: 1,
              endColumn: 10,
              lineText: 'first A.b line',
              matchedText: 'A.b',
            },
            {
              path: 'a.ts',
              line: 2,
              column: 8,
              endLine: 2,
              endColumn: 11,
              lineText: 'second a.B line',
              matchedText: 'a.B',
            },
          ],
        },
      });
    });

    it('searches working copies with case-sensitive multiline expressions', async () => {
      const services = editorServices();
      services.open('a.ts', 'Start\nmiddle\nEnd');
      const adapter = createAdapter(services);
      expect(
        await adapter.handle({
          type: GlyphEditorRequestType.SEARCH_WORKING_COPIES,
          operationId: 'search',
          pattern: 'Start.*End|end',
          options: {
            patternKind: GlyphWorkingCopyPatternKind.REGULAR_EXPRESSION,
            caseSensitive: true,
            multiline: true,
            limit: 10,
          },
        }),
      ).toMatchObject({
        ok: true,
        search: {
          truncated: false,
          matches: [
            { line: 1, column: 1, endLine: 3, endColumn: 4, lineText: 'Start', matchedText: 'Start\nmiddle\nEnd' },
          ],
        },
      });
    });

    it('truncates search results at the requested limit', async () => {
      const services = editorServices();
      services.open('a.ts', 'x x x');
      const adapter = createAdapter(services);
      const response = await adapter.handle({
        type: GlyphEditorRequestType.SEARCH_WORKING_COPIES,
        operationId: 'search',
        pattern: 'x',
        options: { patternKind: GlyphWorkingCopyPatternKind.LITERAL, caseSensitive: true, multiline: false, limit: 0 },
      });
      expect(response).toMatchObject({ ok: true, search: { truncated: true, matches: [{ column: 1 }] } });
    });

    it.each([
      [
        new TextFileOperationError('Binary', TextFileOperationResult.FILE_IS_BINARY),
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
      ],
      [new FileOperationError('Missing', FileOperationResult.FILE_NOT_FOUND), GlyphDesktopErrorCode.NOT_FOUND],
      [
        new FileOperationError('Directory', FileOperationResult.FILE_IS_DIRECTORY),
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
      ],
      [
        new FileOperationError('Not a folder', FileOperationResult.FILE_NOT_DIRECTORY),
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
      ],
      [
        new FileOperationError('Too large', FileOperationResult.FILE_TOO_LARGE),
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
      ],
      [new FileOperationError('Denied', FileOperationResult.FILE_PERMISSION_DENIED), GlyphDesktopErrorCode.INTERNAL],
      [new Error('Broken'), GlyphDesktopErrorCode.INTERNAL],
    ])('reports %s as %s', async (error, code) => {
      const services = editorServices();
      services.textModelService.createModelReference.mockRejectedValue(error);
      const adapter = createAdapter(services);
      expect(await readSnapshot(adapter, 'a.ts')).toEqual({
        operationId: 'read',
        ok: false,
        error: { code, message: error.message, retryable: false },
      });
    });

    it('refuses an occupancy check when trust is revoked while checking', async () => {
      const services = editorServices();
      services.fileService.exists.mockImplementation(async () => {
        services.state.trusted = false;
        return true;
      });
      const adapter = createAdapter(services);
      expect(
        await adapter.handle({ type: GlyphEditorRequestType.EXISTS, operationId: 'exists', path: 'a.ts' }),
      ).toMatchObject(failure(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE));
    });

    it('reports thrown values that are not errors', async () => {
      const services = editorServices();
      services.textModelService.createModelReference.mockRejectedValue('Disconnected');
      const adapter = createAdapter(services);
      expect(await readSnapshot(adapter, 'a.ts')).toMatchObject({
        ok: false,
        error: { code: GlyphDesktopErrorCode.INTERNAL, message: 'Disconnected' },
      });
    });

    it('reports stale documents as retryable', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      model.write('typed');
      expect(await applyText(adapter, textMutation(before, 'changed'))).toMatchObject({
        ok: false,
        error: { code: GlyphDesktopErrorCode.STALE_DOCUMENT, retryable: true },
      });
    });
  });

  describe(GlyphEditorAdapter.prototype.contextPath, () => {
    it('names untitled documents by their path', () => {
      const adapter = createAdapter(editorServices());
      expect(adapter.contextPath(URI.from({ scheme: 'untitled', path: '/Untitled-1' }))).toBe('Untitled-1');
    });

    it('refuses resources that are neither files nor untitled documents', () => {
      const adapter = createAdapter(editorServices());
      expect(() => adapter.contextPath(URI.parse('git:/workspace/a.ts'))).toThrow(
        expect.objectContaining({ code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE }),
      );
    });

    it('refuses files outside of every workspace folder', () => {
      const adapter = createAdapter(editorServices());
      expect(() => adapter.contextPath(URI.file('/elsewhere/a.ts'))).toThrow(
        expect.objectContaining({ code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE }),
      );
    });
  });

  describe(GlyphEditorAdapter.prototype.captureContext, () => {
    it('captures a whole file with its source revision', async () => {
      const model = createTextModel('alpha\nbeta', null, undefined, URI.file('/workspace/a.ts'));
      onTestFinished(() => {
        model.dispose();
      });
      const adapter = createAdapter(editorServices());
      const attachment = await adapter.captureContext(model);
      expect(attachment).toMatchObject({
        kind: 'file',
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
        text: 'alpha\nbeta',
        sourceRevision: `${attachment.token!.workspaceGeneration}:${attachment.token!.incarnation}:1`,
      });
      expect(attachment).not.toHaveProperty('range');
    });

    it('captures a selected range', async () => {
      const model = createTextModel('alpha\nbeta', null, undefined, URI.file('/workspace/a.ts'));
      onTestFinished(() => {
        model.dispose();
      });
      const adapter = createAdapter(editorServices());
      const range = { start: { line: 1, column: 3 }, end: { line: 2, column: 3 } };
      expect(await adapter.captureContext(model, range)).toMatchObject({ kind: 'selection', text: 'pha\nbe', range });
    });

    it.each([
      { start: { line: 0, column: 1 }, end: { line: 1, column: 1 } },
      { start: { line: 1, column: 1 }, end: { line: 3, column: 1 } },
      { start: { line: 2, column: 1 }, end: { line: 1, column: 1 } },
      { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
      { start: { line: 1, column: 1 }, end: { line: 1, column: 0 } },
      { start: { line: 1, column: 9 }, end: { line: 2, column: 1 } },
      { start: { line: 1, column: 1 }, end: { line: 2, column: 9 } },
      { start: { line: 1, column: 4 }, end: { line: 1, column: 2 } },
    ])('refuses a range that no longer fits the document: %j', async range => {
      const model = createTextModel('alpha\nbeta', null, undefined, URI.file('/workspace/a.ts'));
      onTestFinished(() => {
        model.dispose();
      });
      const adapter = createAdapter(editorServices());
      await expect(adapter.captureContext(model, range)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.STALE_DOCUMENT,
      });
    });

    it('refuses capture in an untrusted workspace', async () => {
      const model = createTextModel('alpha', null, undefined, URI.file('/workspace/a.ts'));
      onTestFinished(() => {
        model.dispose();
      });
      const services = editorServices();
      services.state.trusted = false;
      const adapter = createAdapter(services);
      await expect(adapter.captureContext(model)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
      });
    });

    it('refuses capture from unsupported resources', async () => {
      const model = createTextModel('alpha', null, undefined, URI.parse('git:/workspace/a.ts'));
      onTestFinished(() => {
        model.dispose();
      });
      const adapter = createAdapter(editorServices());
      await expect(adapter.captureContext(model)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
      });
    });

    it('refuses capture when trust is revoked while hashing', async () => {
      const model = createTextModel('alpha', null, undefined, URI.file('/workspace/a.ts'));
      onTestFinished(() => {
        model.dispose();
      });
      const services = editorServices();
      const adapter = createAdapter(services);
      const capture = adapter.captureContext(model);
      services.state.trusted = false;
      await expect(capture).rejects.toMatchObject({ code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE });
    });

    it('refuses capture when tokens are invalidated while hashing', async () => {
      const model = createTextModel('alpha', null, undefined, URI.file('/workspace/a.ts'));
      onTestFinished(() => {
        model.dispose();
      });
      const adapter = createAdapter(editorServices());
      const capture = adapter.captureContext(model);
      adapter.invalidate();
      await expect(capture).rejects.toMatchObject({ code: GlyphDesktopErrorCode.STALE_DOCUMENT });
    });
  });

  describe(GlyphEditorAdapter.prototype.isCurrentContext, () => {
    it('recognizes only a capture of the current model version', async () => {
      const model = createTextModel('alpha', null, undefined, URI.file('/workspace/a.ts'));
      const twin = createTextModel('alpha', null, undefined, URI.file('/workspace/a.ts'));
      onTestFinished(() => {
        model.dispose();
        twin.dispose();
      });
      const adapter = createAdapter(editorServices());
      const attachment = await adapter.captureContext(model);
      expect(adapter.isCurrentContext(model, attachment)).toBe(true);
      expect(adapter.isCurrentContext(twin, attachment)).toBe(false);
      expect(adapter.isCurrentContext(model, { ...attachment, token: undefined })).toBe(false);
      model.setValue('beta');
      expect(adapter.isCurrentContext(model, attachment)).toBe(false);
      adapter.invalidate();
      expect(adapter.isCurrentContext(model, await adapter.captureContext(model))).toBe(true);
      expect(adapter.isCurrentContext(model, attachment)).toBe(false);
    });
  });

  describe(GlyphEditorAdapter.prototype.read, () => {
    it.each([-1, 1.5])('refuses a byte budget of %s', async maxBytes => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      await expect(adapter.read('a.ts', maxBytes)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.INVALID_REQUEST,
      });
    });

    it('reads an unopened file of unknown size within a byte budget', async () => {
      const services = editorServices();
      services.disk.set('/workspace/a.ts', 'text');
      services.fileService.stat.mockResolvedValue({});
      const adapter = createAdapter(services);
      expect(await adapter.read('a.ts', 10)).toMatchObject({ text: 'text', byteLength: 4 });
    });

    it('refuses an unopened file larger than its byte budget', async () => {
      const services = editorServices();
      services.disk.set('/workspace/a.ts', 'text');
      const adapter = createAdapter(services);
      await expect(adapter.read('a.ts', 3)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
        details: { maxBytes: 3, actualBytes: 4 },
      });
      expect(services.textModelService.createModelReference).not.toHaveBeenCalled();
    });

    it('counts a byte order mark against the byte budget', async () => {
      const services = editorServices();
      services.open('a.ts', 'ab', { byteOrderMark: true });
      const adapter = createAdapter(services);
      await expect(adapter.read('a.ts', 4)).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
        details: { maxBytes: 4, actualBytes: 5 },
      });
      expect(await adapter.read('a.ts', 5)).toMatchObject({ text: 'ab', byteOrderMark: true, byteLength: 5 });
    });

    it('refuses a document resolved after its tokens were invalidated', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const reference = { object: { textEditorModel: model }, dispose: vi.fn() };
      services.textModelService.createModelReference.mockImplementationOnce(async () => {
        adapter.invalidate();
        return reference;
      });
      await expect(adapter.read('a.ts')).rejects.toMatchObject({ code: GlyphDesktopErrorCode.STALE_DOCUMENT });
      expect(reference.dispose).toHaveBeenCalledOnce();
    });

    it('refuses a document resolved after the adapter was disposed', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const reference = { object: { textEditorModel: model }, dispose: vi.fn() };
      services.textModelService.createModelReference.mockImplementationOnce(async () => {
        adapter.dispose();
        return reference;
      });
      await expect(adapter.read('a.ts')).rejects.toMatchObject({ code: GlyphDesktopErrorCode.STALE_DOCUMENT });
      expect(reference.dispose).toHaveBeenCalledOnce();
    });

    it('shares one document reference between concurrent reads', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const [first, second] = await Promise.all([adapter.read('a.ts'), adapter.read('a.ts')]);
      expect(first.token).toEqual(second.token);
      const [one, two] = (await Promise.all(
        services.textModelService.createModelReference.mock.results.map((r): unknown => r.value),
      )) as { dispose: Mock }[];
      expect(one.dispose).not.toHaveBeenCalled();
      expect(two.dispose).toHaveBeenCalledOnce();
    });

    it.each(['/workspace/a.ts', 'a\\b.ts', 'a//b.ts', '../a.ts', './a.ts', 'a\0.ts'])(
      'refuses the path %j',
      async path => {
        const adapter = createAdapter(editorServices());
        await expect(adapter.read(path)).rejects.toMatchObject({ code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE });
      },
    );

    it('refuses a path under an unknown root of a multi-root workspace', async () => {
      const services = editorServices();
      services.workspace.folders = [
        { name: 'one', uri: URI.file('/one') },
        { name: 'two', uri: URI.file('/two') },
      ];
      const adapter = createAdapter(services);
      await expect(adapter.read('three/a.ts')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
      });
    });

    it('refuses paths when the workspace has no file folders', async () => {
      const services = editorServices();
      services.workspace.folders = [{ name: 'remote', uri: URI.parse('vscode-remote://host/workspace') }];
      const adapter = createAdapter(services);
      await expect(adapter.read('a.ts')).rejects.toMatchObject({ code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE });
    });

    it('refuses paths that resolve outside of the workspace', async () => {
      const services = editorServices();
      services.uriIdentityService.asCanonicalUri = () => URI.file('/elsewhere/a.ts');
      const adapter = createAdapter(services);
      await expect(adapter.read('a.ts')).rejects.toMatchObject({ code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE });
    });
  });

  describe(GlyphEditorAdapter.prototype.applyFile, () => {
    it('refuses a rename without a destination', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.RENAME))).toMatchObject(
        failure(GlyphDesktopErrorCode.INVALID_REQUEST),
      );
    });

    it('creates a file with a byte order mark and returns its snapshot', async () => {
      const services = editorServices();
      const adapter = createAdapter(services);
      const response = await applyFile(adapter, {
        operationId: 'create',
        undoGroupId: 'group',
        kind: GlyphFileMutationKind.CREATE,
        path: 'new.ts',
        text: 'fresh',
        byteOrderMark: true,
      });
      const [[edits]] = services.bulkEditService.apply.mock.calls;
      const contents = await (edits[0] as ResourceFileEdit).options.contents!;
      expect(Array.from(contents.buffer.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
      expect(response).toMatchObject({
        ok: true,
        snapshot: { path: 'new.ts', text: 'fresh', byteOrderMark: true, byteLength: 8 },
        receipt: { operationId: 'create', state: GlyphMutationReceiptState.APPLIED, beforeRevision: '' },
      });
    });

    it('returns the recorded receipt when a creation repeats', async () => {
      const services = editorServices();
      const adapter = createAdapter(services);
      const mutation = {
        operationId: 'create',
        undoGroupId: 'group',
        kind: GlyphFileMutationKind.CREATE,
        path: 'new.ts',
        text: 'fresh',
        byteOrderMark: false,
      } as const;
      const first = await applyFile(adapter, mutation);
      expect(await applyFile(adapter, mutation)).toEqual(first);
      services.dirty.add('/workspace/new.ts');
      expect(await applyFile(adapter, { ...mutation, save: true })).toMatchObject({
        ok: true,
        snapshot: { dirty: false },
      });
      expect(services.textFileService.save).toHaveBeenCalledOnce();
      expect(services.bulkEditService.apply).toHaveBeenCalledOnce();
    });

    it('saves a created file when requested', async () => {
      const services = editorServices();
      const adapter = createAdapter(services);
      expect(
        await applyFile(adapter, {
          operationId: 'create',
          undoGroupId: 'group',
          kind: GlyphFileMutationKind.CREATE,
          path: 'new.ts',
          text: 'fresh',
          byteOrderMark: false,
          save: true,
        }),
      ).toMatchObject({ ok: true, snapshot: { text: 'fresh', dirty: false } });
      expect(services.textFileService.save).not.toHaveBeenCalled();
    });

    it('refuses a repeated creation after the file changed', async () => {
      const services = editorServices();
      const adapter = createAdapter(services);
      const mutation = {
        operationId: 'create',
        undoGroupId: 'group',
        kind: GlyphFileMutationKind.CREATE,
        path: 'new.ts',
        text: 'fresh',
        byteOrderMark: false,
      } as const;
      await applyFile(adapter, mutation);
      services.models[0].write('typed');
      expect(await applyFile(adapter, mutation)).toMatchObject(failure(GlyphDesktopErrorCode.STALE_DOCUMENT));
    });

    it('refuses to create a file over an existing one', async () => {
      const services = editorServices();
      services.disk.set('/workspace/new.ts', 'existing');
      const adapter = createAdapter(services);
      expect(
        await applyFile(adapter, {
          operationId: 'create',
          undoGroupId: 'group',
          kind: GlyphFileMutationKind.CREATE,
          path: 'new.ts',
          text: 'fresh',
          byteOrderMark: false,
        }),
      ).toMatchObject({
        ok: false,
        error: { code: GlyphDesktopErrorCode.STALE_DOCUMENT, details: { reason: 'The destination already exists.' } },
      });
    });

    it('refuses a creation that Bulk Edit does not apply', async () => {
      const services = editorServices();
      services.bulkEditService.apply.mockResolvedValue({ isApplied: false });
      const adapter = createAdapter(services);
      expect(
        await applyFile(adapter, {
          operationId: 'create',
          undoGroupId: 'group',
          kind: GlyphFileMutationKind.CREATE,
          path: 'new.ts',
          text: 'fresh',
          byteOrderMark: false,
        }),
      ).toMatchObject(failure(GlyphDesktopErrorCode.STALE_DOCUMENT));
      expect(await adapter.inspectReceipt('create')).toBeUndefined();
    });

    it('deletes a file and treats a repeated deletion as complete', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      const first = await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE));
      expect(first).toMatchObject({
        ok: true,
        receipt: { state: GlyphMutationReceiptState.APPLIED, beforeRevision: before.contentRevision },
      });
      expect(await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE))).toEqual(first);
      expect(await readSnapshot(adapter, 'a.ts')).toMatchObject(failure(GlyphDesktopErrorCode.NOT_FOUND));
      services.disk.set('/workspace/a.ts', 'again');
      expect(await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
      expect(services.bulkEditService.apply).toHaveBeenCalledOnce();
    });

    it('treats a removed file with a live model as occupied only while it has unsaved changes', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      services.bulkEditService.apply.mockImplementation(async () => {
        services.disk.delete('/workspace/a.ts');
        return { isApplied: true };
      });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE));
      const exists = () => adapter.handle({ type: GlyphEditorRequestType.EXISTS, operationId: 'exists', path: 'a.ts' });
      expect(await exists()).toMatchObject({ ok: true, exists: false });
      services.dirty.add('/workspace/a.ts');
      expect(await exists()).toMatchObject({ ok: true, exists: true });
      expect(await readSnapshot(adapter, 'a.ts')).toMatchObject({ ok: true, snapshot: { dirty: true } });
    });

    it('records uncertain evidence when a deleted file remains on disk', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      services.bulkEditService.apply.mockResolvedValue({ isApplied: true });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE))).toMatchObject({
        ok: false,
        error: { code: GlyphDesktopErrorCode.STALE_DOCUMENT },
        receipt: { state: GlyphMutationReceiptState.UNKNOWN },
      });
      expect(await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
      expect(services.bulkEditService.apply).toHaveBeenCalledOnce();
    });

    it('refuses to delete a file with unsaved changes', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      services.dirty.add('/workspace/a.ts');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE))).toMatchObject({
        ok: false,
        error: {
          code: GlyphDesktopErrorCode.STALE_DOCUMENT,
          details: { reason: 'Save or revert unsaved changes before deleting this file.' },
        },
      });
    });

    it('refuses a structural edit for a stale token', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(
        await applyFile(
          adapter,
          fileMutation({ ...before, token: { ...before.token, version: 9 } }, GlyphFileMutationKind.DELETE),
        ),
      ).toMatchObject(failure(GlyphDesktopErrorCode.STALE_DOCUMENT));
    });

    it('refuses a structural edit when the file on disk differs from its clean model', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      services.disk.set('/workspace/a.ts', 'other');
      expect(await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
    });

    it('refuses a structural edit when the model was closed', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      services.modelService.getModel.mockReturnValue(null);
      expect(await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
    });

    it('renames a file with unsaved changes', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      services.dirty.add('/workspace/a.ts');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(
        await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.RENAME, { target: 'b.ts' })),
      ).toMatchObject({
        ok: true,
        snapshot: { path: 'b.ts', text: 'text' },
        receipt: { state: GlyphMutationReceiptState.APPLIED },
      });
      expect(services.fileService.readFile).not.toHaveBeenCalled();
    });

    it('refuses a rename whose source remains on disk', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      services.bulkEditService.apply.mockImplementation(async () => {
        services.disk.set('/workspace/b.ts', 'text');
        return { isApplied: true };
      });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(
        await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.RENAME, { target: 'b.ts' })),
      ).toMatchObject({
        ...failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
        receipt: { state: GlyphMutationReceiptState.UNKNOWN },
      });
    });

    it('cancels a structural edit when its document changes during Bulk Edit', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      services.bulkEditService.apply.mockImplementation(async edits => {
        model.write('typed');
        await (edits[0] as ResourceFileEdit & { validate(): Promise<void> }).validate();
        return { isApplied: true };
      });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(
        await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.RENAME, { target: 'b.ts' })),
      ).toMatchObject(failure(GlyphDesktopErrorCode.STALE_DOCUMENT));
      expect(services.disk.has('/workspace/b.ts')).toBe(false);
    });

    it.each([
      ['trust is revoked', GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE],
      ['tokens are invalidated', GlyphDesktopErrorCode.STALE_DOCUMENT],
      ['the version moves silently', GlyphDesktopErrorCode.STALE_DOCUMENT],
      ['the disk bytes change', GlyphDesktopErrorCode.STALE_DOCUMENT],
      ['the destination appears', GlyphDesktopErrorCode.STALE_DOCUMENT],
    ])('revalidates a rename inside Bulk Edit when %s', async (race, code) => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      services.bulkEditService.apply.mockImplementation(async edits => {
        if (race === 'trust is revoked') services.state.trusted = false;
        if (race === 'tokens are invalidated') adapter.invalidate();
        if (race === 'the version moves silently') model.version++;
        if (race === 'the disk bytes change') services.disk.set('/workspace/a.ts', 'other');
        if (race === 'the destination appears') services.disk.set('/workspace/b.ts', 'occupied');
        await (edits[0] as ResourceFileEdit & { validate(): Promise<void> }).validate();
        return { isApplied: true };
      });
      const before = await adapter.read('a.ts');
      expect(
        await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.RENAME, { target: 'b.ts' })),
      ).toMatchObject(failure(code));
      expect(await adapter.inspectReceipt('file')).toBeUndefined();
    });

    it.each([
      ['trust is revoked', GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE],
      ['the version moves silently', GlyphDesktopErrorCode.STALE_DOCUMENT],
    ])('revalidates a deletion after reading its disk bytes when %s', async (race, code) => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      const readFile = services.fileService.readFile.getMockImplementation()!;
      services.fileService.readFile.mockImplementation(async resource => {
        if (services.fileService.readFile.mock.calls.length === 2) {
          if (race === 'trust is revoked') services.state.trusted = false;
          else model.version++;
        }
        return readFile(resource);
      });
      expect(await applyFile(adapter, fileMutation(before, GlyphFileMutationKind.DELETE))).toMatchObject(failure(code));
      expect(services.bulkEditService.apply).not.toHaveBeenCalled();
    });
  });

  describe(GlyphEditorAdapter.prototype.apply, () => {
    it('applies a text edit and records an applied receipt', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      const response = await applyText(adapter, textMutation(before, 'changed'));
      expect(response).toMatchObject({
        ok: true,
        snapshot: { text: 'changed', dirty: true },
        receipt: { state: GlyphMutationReceiptState.APPLIED, beforeRevision: before.contentRevision },
      });
      expect(response.ok && response.receipt?.afterRevision).toBe(response.ok && response.snapshot?.contentRevision);
    });

    it('reports the recorded receipt of an applied edit when asked to inspect it', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      const applied = await applyText(adapter, textMutation(before, 'changed'));

      const inspected = await adapter.handle({
        type: GlyphEditorRequestType.INSPECT_MUTATION_RECEIPT,
        operationId: 'edit',
      });

      expect(inspected).toEqual({ operationId: 'edit', ok: true, receipt: applied.ok && applied.receipt });
    });

    it('asks the editor to apply edits to text with surrogate pairs exactly as given', async () => {
      const services = editorServices();
      services.open('a.ts', 'café 🌱');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');

      await applyText(adapter, textMutation(before, 'café 🌳'));

      const [[edits]] = services.bulkEditService.apply.mock.calls;
      expect(edits[0].metadata).toEqual({ label: expect.any(String), needsConfirmation: false });
    });

    it('lets the editor minimise edits to text without surrogate pairs', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');

      await applyText(adapter, textMutation(before, 'changed'));

      const [[edits]] = services.bulkEditService.apply.mock.calls;
      expect(edits[0].metadata).toBeUndefined();
    });

    it('returns the recorded receipt when an applied operation repeats', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      const first = await applyText(adapter, textMutation(before, 'changed'));
      expect(await applyText(adapter, textMutation(before, 'changed'))).toEqual(first);
      expect(services.bulkEditService.apply).toHaveBeenCalledOnce();
    });

    it('saves a repeated operation whose text still matches', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      await applyText(adapter, textMutation(before, 'changed'));
      expect(await applyText(adapter, textMutation(before, 'changed', { save: true }))).toMatchObject({
        ok: true,
        snapshot: { text: 'changed', dirty: false },
      });
      expect(services.disk.get('/workspace/a.ts')).toBe('changed');
      expect(services.bulkEditService.apply).toHaveBeenCalledOnce();
    });

    it('refuses to save a repeated operation after its text changed', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      await applyText(adapter, textMutation(before, 'changed'));
      model.write('typed');
      expect(await applyText(adapter, textMutation(before, 'changed', { save: true }))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
      expect(services.textFileService.save).not.toHaveBeenCalled();
    });

    it('records uncertain evidence when cancellation follows an untagged change, and refuses to repeat it', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      services.bulkEditService.apply.mockImplementation(async () => {
        model.write('changed');
        adapter.invalidate();
        return { isApplied: true };
      });
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed'))).toMatchObject({
        ...failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
        receipt: { state: GlyphMutationReceiptState.UNKNOWN },
      });
      expect(await applyText(adapter, textMutation(before, 'changed'))).toMatchObject({
        ...failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
        receipt: { state: GlyphMutationReceiptState.UNKNOWN },
      });
      expect(services.bulkEditService.apply).toHaveBeenCalledOnce();
    });

    it('retains uncertain evidence when Bulk Edit declines a cancelled untagged change', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      services.bulkEditService.apply.mockImplementation(async () => {
        model.write('changed');
        adapter.invalidate();
        return { isApplied: false };
      });
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed'))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
      expect(await adapter.inspectReceipt('edit')).toMatchObject({
        state: GlyphMutationReceiptState.UNKNOWN,
        afterRevision: expect.any(String),
      });
    });

    it('treats an untagged change as applied once Bulk Edit confirms it', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      services.bulkEditService.apply.mockImplementation(async () => {
        model.write('changed');
        return { isApplied: true };
      });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed'))).toMatchObject({
        ok: true,
        receipt: { state: GlyphMutationReceiptState.APPLIED, afterRevision: expect.any(String) },
      });
    });

    it('ignores content events that leave the version unchanged', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      services.bulkEditService.apply.mockImplementation(async (edits, options) => {
        model.notify({ detailedReasons: [], isEolChange: false });
        services.writeText(edits[0] as ResourceTextEdit, options.reason);
        return { isApplied: true };
      });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed'))).toMatchObject({
        ok: true,
        receipt: { state: GlyphMutationReceiptState.APPLIED },
      });
    });

    it('keeps the newest receipt when tagged changes land in quick succession', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      services.bulkEditService.apply.mockImplementation(async (_edits, options) => {
        model.write('first', [options.reason]);
        model.write('second', [options.reason]);
        return { isApplied: true };
      });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      const response = await applyText(adapter, textMutation(before, 'second'));
      expect(response).toMatchObject({
        ok: true,
        snapshot: { text: 'second' },
        receipt: { appliedToken: { version: 3 } },
      });
      expect(response.ok && response.receipt?.afterRevision).toBe(response.ok && response.snapshot?.contentRevision);
    });

    it('refuses an edit that Bulk Edit reports applied without changing the document', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      services.bulkEditService.apply.mockResolvedValue({ isApplied: true });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed'))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
      expect(await adapter.inspectReceipt('edit')).toBeUndefined();
    });

    it('records an unchanged document as an applied no-op', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'text'))).toMatchObject({
        ok: true,
        receipt: {
          state: GlyphMutationReceiptState.APPLIED,
          beforeRevision: before.contentRevision,
          afterRevision: before.contentRevision,
          appliedToken: before.token,
        },
      });
    });

    it('refuses an edit for a stale token', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(
        await applyText(adapter, textMutation(before, 'changed', { expectedToken: { ...before.token, version: 9 } })),
      ).toMatchObject(failure(GlyphDesktopErrorCode.STALE_DOCUMENT));
      expect(services.bulkEditService.apply).not.toHaveBeenCalled();
    });

    it('refuses an edit that changes the byte order mark', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed', { byteOrderMark: true }))).toMatchObject(
        failure(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE),
      );
    });

    it('refuses a carriage-return conversion that the editor cannot express', async () => {
      const services = editorServices();
      services.open('a.ts', 'one\ntwo');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'one\rtwo'))).toMatchObject(
        failure(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE),
      );
      expect(services.bulkEditService.apply).not.toHaveBeenCalled();
    });

    it('refuses an edit when trust is revoked before writing', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      services.state.trusted = false;
      await expect(adapter.apply(textMutation(before, 'changed'))).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
      });
      expect(services.bulkEditService.apply).not.toHaveBeenCalled();
    });

    it('refuses an edit when tokens are invalidated while it is prepared', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      model.getEOL = () => {
        adapter.invalidate();
        return '\n';
      };
      expect(await applyText(adapter, textMutation(before, 'changed'))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
      expect(services.bulkEditService.apply).not.toHaveBeenCalled();
    });

    it('applies an EOL-only conversion', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'line\n');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'line\r\n'))).toMatchObject({
        ok: true,
        snapshot: { text: 'line\r\n' },
        receipt: { state: GlyphMutationReceiptState.APPLIED },
      });
      expect(model.eol).toBe('\r\n');
    });

    it('applies text and EOL changes as separately guarded steps in one undo group', async () => {
      const services = editorServices();
      services.open('a.ts', 'line\n');
      const operations: { group: unknown; edits: ResourceTextEdit[] }[] = [];
      services.instantiationService.createInstance.mockImplementation(
        (...args: [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, ResourceTextEdit[]]) => {
          operations.push({ group: args[4], edits: args[8] });
          return {
            apply: async (reason: unknown) => {
              for (const edit of args[8]) services.writeText(edit, reason);
              return [URI.file('/workspace/a.ts')];
            },
          };
        },
      );
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'LINE\r\n', { save: true }))).toMatchObject({
        ok: true,
        snapshot: { text: 'LINE\r\n', dirty: false },
        receipt: { state: GlyphMutationReceiptState.APPLIED },
      });
      expect(operations).toHaveLength(2);
      expect(operations[0].group).toBe(operations[1].group);
      expect(operations[1].edits[0].textEdit).toMatchObject({ text: '', eol: EndOfLineSequence.CRLF });
      expect(operations[1].edits[0].versionId).toBe(2);
      expect(services.bulkEditService.apply).not.toHaveBeenCalled();
    });

    it.each([
      ['trust is revoked', GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE],
      ['the text step applies nothing', GlyphDesktopErrorCode.STALE_DOCUMENT],
    ])('stops before the EOL step when %s', async (race, code) => {
      const services = editorServices();
      services.open('a.ts', 'line\n');
      services.instantiationService.createInstance.mockImplementation(
        (...args: [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown, ResourceTextEdit[]]) => ({
          apply: async (reason: unknown) => {
            if (race === 'trust is revoked') {
              for (const edit of args[8]) services.writeText(edit, reason);
              services.state.trusted = false;
              return [URI.file('/workspace/a.ts')];
            }
            return [];
          },
        }),
      );
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'LINE\r\n'))).toMatchObject(failure(code));
      expect(services.instantiationService.createInstance).toHaveBeenCalledOnce();
    });

    it('saves an applied edit when requested', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed', { save: true }))).toMatchObject({
        ok: true,
        snapshot: { text: 'changed', dirty: false },
      });
      expect(services.textFileService.save).toHaveBeenCalledWith(expect.objectContaining({ path: '/workspace/a.ts' }), {
        skipSaveParticipants: true,
      });
      expect(services.disk.get('/workspace/a.ts')).toBe('changed');
    });

    it('refuses to save when trust is revoked during the edit', async () => {
      const services = editorServices();
      services.open('a.ts', 'text');
      const write = services.bulkEditService.apply.getMockImplementation()!;
      services.bulkEditService.apply.mockImplementation(async (edits, options) => {
        services.state.trusted = false;
        return write(edits, options);
      });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed', { save: true }))).toMatchObject({
        ...failure(GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE),
        receipt: { state: GlyphMutationReceiptState.APPLIED },
      });
      expect(services.textFileService.save).not.toHaveBeenCalled();
    });

    it('refuses to save when the document changes before saving', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      let edited = false;
      const write = services.bulkEditService.apply.getMockImplementation()!;
      services.bulkEditService.apply.mockImplementation(async (edits, options) => {
        edited = true;
        return write(edits, options);
      });
      services.textFileService.isDirty.mockImplementation(() => {
        if (edited) {
          edited = false;
          model.text = 'sneaky';
        }
        return true;
      });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed', { save: true }))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
      expect(services.textFileService.save).not.toHaveBeenCalled();
    });

    it.each([
      ['declines', async () => undefined],
      [
        'leaves the file dirty',
        async (resource: URI) => {
          return resource;
        },
      ],
    ])('reports a save that %s', async (_outcome, save) => {
      const services = editorServices();
      services.open('a.ts', 'text');
      services.textFileService.save.mockImplementation(save);
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed', { save: true }))).toMatchObject({
        ok: false,
        error: {
          code: GlyphDesktopErrorCode.STALE_DOCUMENT,
          details: {
            reason: 'The edit changed the working copy but could not be saved. Save it before running commands.',
          },
        },
        receipt: { state: GlyphMutationReceiptState.APPLIED },
      });
    });

    it('refuses a save that changed the document', async () => {
      const services = editorServices();
      const model = services.open('a.ts', 'text');
      services.textFileService.save.mockImplementation(async (resource: URI) => {
        model.text = 'formatted';
        services.dirty.delete(resource.path);
        return resource;
      });
      const adapter = createAdapter(services);
      const before = await adapter.read('a.ts');
      expect(await applyText(adapter, textMutation(before, 'changed', { save: true }))).toMatchObject(
        failure(GlyphDesktopErrorCode.STALE_DOCUMENT),
      );
    });
  });
});
