import { describe, expect, it, vi, type Mock } from 'vitest';
import { GlyphContextController } from '#vs/workbench/contrib/glyph/browser/GlyphContextController.js';
import { URI } from '#vs/base/common/uri.js';
import { Emitter } from '#vs/base/common/event.js';
import { Selection } from '#vs/editor/common/core/selection.js';
import { EditorType } from '#vs/editor/common/editorCommon.js';
import { QueryType } from '#vs/workbench/services/search/common/search.js';
import { formatFolderContextOutline } from '#glyph/workbench/formatFolderContextOutline.js';
import { GlyphContextCandidateKind } from '#glyph/workbench/GlyphContextActions.js';
import {
  GlyphContextAttachmentKind,
  type GlyphContextAttachment,
} from '#glyph/protocol/connection/GlyphContextAttachment.js';
import type { GlyphTextRange } from '#glyph/protocol/connection/GlyphTextRange.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';

interface Folder {
  name: string;
  uri: URI;
}

interface Stat {
  isDirectory?: boolean;
  isSymbolicLink?: boolean;
  size?: number;
  children?: { resource: URI; isDirectory: boolean; isSymbolicLink: boolean }[];
}

function codeEditor(model: { uri: URI } | null, selections: Selection[] | null = [new Selection(1, 1, 1, 5)]) {
  const focus = new Emitter<void>();
  return {
    getEditorType: () => EditorType.ICodeEditor,
    getModel: () => model,
    getSelections: () => selections,
    onDidFocusEditorText: focus.event,
    focus: () => {
      focus.fire();
    },
  };
}

function diffEditor(original: ReturnType<typeof codeEditor>, modified: ReturnType<typeof codeEditor>) {
  return {
    getEditorType: () => EditorType.IDiffEditor,
    getOriginalEditor: () => original,
    getModifiedEditor: () => modified,
  };
}

function controllerServices() {
  const folders: Folder[] = [{ name: 'workspace', uri: URI.file('/workspace') }];
  const models: { uri: URI }[] = [];
  const stats = new Map<string, Stat>();
  const editorAdded = new Emitter<ReturnType<typeof codeEditor>>();
  const folderOf = (uri: URI) =>
    folders.find(folder => uri.path === folder.uri.path || uri.path.startsWith(`${folder.uri.path}/`));
  const contextPath = vi.fn((uri: URI) => {
    if (uri.scheme === 'untitled') return uri.path.replace(/^\//u, '');
    const folder = uri.scheme === 'file' ? folderOf(uri) : undefined;
    if (!folder) throw new Error('Outside of the workspace');
    const path = uri.path.slice(folder.uri.path.length + 1);
    return folders.length > 1 ? `${folder.name}/${path}` : path;
  });
  const composer = { insertAttachments: vi.fn((_attachments: { side?: string }[]) => undefined) };
  const services = {
    folders,
    models,
    stats,
    editorAdded,
    composer,
    codeEditorList: [] as ReturnType<typeof codeEditor>[],
    adapter: {
      contextPath,
      isCurrentContext: vi.fn(() => true),
      captureContext: vi.fn(async (model: { uri: URI }, range?: GlyphTextRange): Promise<GlyphContextAttachment> => ({
        id: 'capture',
        kind: range ? GlyphContextAttachmentKind.SELECTION : GlyphContextAttachmentKind.FILE,
        uri: model.uri.toString(),
        path: contextPath(model.uri),
        text: 'text',
        contentRevision: 'revision',
        ...(range ? { range } : {}),
      })),
    },
    ide: {
      select: vi.fn(async () => []),
      captureTestSelection: vi.fn(async (_model: unknown, selection: Selection) => ({
        id: 'test',
        kind: GlyphContextAttachmentKind.TEST,
        uri: 'vscode-test-data://results/run/output/0',
        path: `Test output ${selection.startLineNumber}`,
        text: 'output',
        contentRevision: 'revision',
      })),
      openSource: vi.fn(async () => false),
    },
    editors: { activeTextEditorControl: undefined as unknown, openEditor: vi.fn(async () => undefined) },
    modelService: {
      getModels: () => models,
      getModel: (uri: URI) => models.find(model => model.uri.toString() === uri.toString()) ?? null,
    },
    resolver: {
      createModelReference: vi.fn(async (uri: URI) => ({ object: { textEditorModel: { uri } }, dispose: vi.fn() })),
    },
    workspace: {
      getWorkspace: () => ({ folders }),
      getWorkspaceFolder: vi.fn((uri: URI): Folder | null => folderOf(uri) ?? null),
      isInsideWorkspace: (uri: URI) => folderOf(uri) !== undefined,
    },
    trust: { isWorkspaceTrusted: vi.fn(() => true) },
    search: {
      fileSearch: vi.fn(async (): Promise<{ results: { resource: URI }[]; limitHit?: boolean }> => ({ results: [] })),
    },
    files: {
      resolve: vi.fn(async (uri: URI): Promise<Stat> => stats.get(uri.path) ?? { children: [] }),
      stat: vi.fn(async (uri: URI): Promise<Stat> => stats.get(uri.path) ?? { isDirectory: false, size: 4 }),
      exists: vi.fn(async (_uri: URI) => true),
    },
    dialogs: { showOpenDialog: vi.fn(async (): Promise<URI[] | undefined> => undefined) },
    commands: { executeCommand: vi.fn(async () => undefined) },
  };
  return services;
}

type ControllerServices = ReturnType<typeof controllerServices>;

function createController(services: ControllerServices) {
  return new GlyphContextController(
    services.adapter as never,
    () => services.composer as never,
    services.editors as never,
    { listCodeEditors: () => services.codeEditorList, onCodeEditorAdd: services.editorAdded.event } as never,
    services.modelService as never,
    services.resolver as never,
    services.workspace as never,
    services.trust as never,
    services.search as never,
    services.files as never,
    services.dialogs as never,
    services.commands as never,
    { createInstance: () => services.ide } as never,
  );
}

describe(GlyphContextController, () => {
  describe(GlyphContextController.prototype.selectIdeContext, () => {
    it('asks for IDE context from the focused side of a diff editor', async () => {
      const services = controllerServices();
      const original = codeEditor({ uri: URI.file('/workspace/a.ts') });
      const modified = codeEditor({ uri: URI.file('/workspace/a.ts') });
      services.codeEditorList.push(original);
      services.editors.activeTextEditorControl = diffEditor(original, modified);
      const controller = createController(services);
      services.editorAdded.fire(modified);
      await controller.selectIdeContext();
      original.focus();
      await controller.selectIdeContext();
      modified.focus();
      await controller.selectIdeContext();
      expect(services.ide.select.mock.calls).toEqual([[modified], [original], [modified]]);
    });

    it('asks for IDE context without an editor when no text editor is active', async () => {
      const services = controllerServices();
      services.editors.activeTextEditorControl = { getEditorType: () => 'other' };
      await createController(services).selectIdeContext();
      expect(services.ide.select).toHaveBeenCalledWith(undefined);
    });

    it('stops tracking editor focus once disposed', async () => {
      const services = controllerServices();
      const original = codeEditor({ uri: URI.file('/workspace/a.ts') });
      const modified = codeEditor({ uri: URI.file('/workspace/a.ts') });
      services.codeEditorList.push(original);
      services.editors.activeTextEditorControl = diffEditor(original, modified);
      const controller = createController(services);
      controller.dispose();
      original.focus();
      await controller.selectIdeContext();
      expect(services.ide.select).toHaveBeenCalledWith(modified);
    });
  });

  describe(GlyphContextController.prototype.attachSelection, () => {
    it('refuses to attach a selection in an untrusted workspace', async () => {
      const services = controllerServices();
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      await expect(createController(services).attachSelection()).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
      });
    });

    it.each([
      ['no editor is active', undefined],
      ['the editor has no model', codeEditor(null)],
      ['the editor reports no selections', codeEditor({ uri: URI.file('/workspace/a.ts') }, null)],
      ['every selection is empty', codeEditor({ uri: URI.file('/workspace/a.ts') }, [new Selection(1, 2, 1, 2)])],
    ])('asks for highlighted text when %s', async (_case, control) => {
      const services = controllerServices();
      services.editors.activeTextEditorControl = control;
      await expect(createController(services).attachSelection()).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.INVALID_REQUEST,
        message: 'Highlight text in an editor before attaching a selection.',
      });
    });

    it('attaches selected test output through the IDE context', async () => {
      const services = controllerServices();
      const model = { uri: URI.parse('vscode-test-data://results/run/output/0') };
      services.editors.activeTextEditorControl = codeEditor(model, [
        new Selection(1, 1, 1, 3),
        new Selection(2, 1, 2, 3),
      ]);
      await createController(services).attachSelection();
      expect(services.ide.captureTestSelection).toHaveBeenCalledTimes(2);
      expect(services.composer.insertAttachments).toHaveBeenCalledWith([
        expect.objectContaining({ path: 'Test output 1' }),
        expect.objectContaining({ path: 'Test output 2' }),
      ]);
    });

    it('attaches every highlighted range of a plain editor', async () => {
      const services = controllerServices();
      services.editors.activeTextEditorControl = codeEditor({ uri: URI.file('/workspace/a.ts') }, [
        new Selection(1, 1, 1, 3),
        new Selection(2, 2, 2, 2),
        new Selection(3, 1, 4, 2),
      ]);
      await createController(services).attachSelection();
      expect(services.composer.insertAttachments).toHaveBeenCalledWith([
        expect.objectContaining({ range: { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } } }),
        expect.objectContaining({ range: { start: { line: 3, column: 1 }, end: { line: 4, column: 2 } } }),
      ]);
      expect(services.composer.insertAttachments.mock.calls[0][0][0]).not.toHaveProperty('side');
    });

    it('labels selections with the side of a diff editor they came from', async () => {
      const services = controllerServices();
      const original = codeEditor({ uri: URI.file('/workspace/a.ts') });
      const modified = codeEditor({ uri: URI.file('/workspace/a.ts') });
      services.codeEditorList.push(original, modified);
      services.editors.activeTextEditorControl = diffEditor(original, modified);
      const controller = createController(services);
      original.focus();
      await controller.attachSelection();
      modified.focus();
      await controller.attachSelection();
      expect(services.composer.insertAttachments.mock.calls.map(([[attachment]]) => attachment.side)).toEqual([
        'original',
        'modified',
      ]);
    });
  });

  describe(GlyphContextController.prototype.searchFiles, () => {
    it('refuses to search in an untrusted workspace', async () => {
      const services = controllerServices();
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      await expect(createController(services).searchFiles('')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
      });
    });

    it('offers open files, search results, their folders, and top-level folders', async () => {
      const services = controllerServices();
      services.models.push(
        { uri: URI.file('/workspace/src/deep/a.ts') },
        { uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) },
        { uri: URI.file('/elsewhere/b.ts') },
        { uri: URI.parse('git:/workspace/src/deep/a.ts') },
      );
      services.search.fileSearch.mockResolvedValue({ results: [{ resource: URI.file('/workspace/src/b.ts') }] });
      services.stats.set('/workspace', {
        children: [
          { resource: URI.file('/workspace/lib'), isDirectory: true, isSymbolicLink: false },
          { resource: URI.file('/workspace/link'), isDirectory: true, isSymbolicLink: true },
          { resource: URI.file('/workspace/x.ts'), isDirectory: false, isSymbolicLink: false },
        ],
      });
      expect(await createController(services).searchFiles('')).toEqual([
        {
          uri: 'file:///workspace/src/deep/a.ts',
          path: 'src/deep/a.ts',
          kind: GlyphContextCandidateKind.FILE,
          ancestry: ['src', 'deep', 'a.ts'],
        },
        {
          uri: 'file:///workspace/src/deep',
          path: 'src/deep/',
          kind: GlyphContextCandidateKind.FOLDER,
          ancestry: ['src', 'deep'],
        },
        { uri: 'file:///workspace/src', path: 'src/', kind: GlyphContextCandidateKind.FOLDER, ancestry: ['src'] },
        {
          uri: 'file:///workspace',
          path: './',
          kind: GlyphContextCandidateKind.FOLDER,
          name: 'workspace',
          ancestry: ['workspace'],
        },
        {
          uri: 'untitled:Untitled-1',
          path: 'Untitled-1',
          kind: GlyphContextCandidateKind.FILE,
          ancestry: ['Untitled-1'],
        },
        {
          uri: 'file:///workspace/src/b.ts',
          path: 'src/b.ts',
          kind: GlyphContextCandidateKind.FILE,
          ancestry: ['src', 'b.ts'],
        },
        { uri: 'file:///workspace/lib', path: 'lib/', kind: GlyphContextCandidateKind.FOLDER, ancestry: ['lib'] },
      ]);
      const [[query]] = services.search.fileSearch.mock.calls as unknown as [[{ folderQueries: { folder: URI }[] }]];
      expect({
        ...query,
        folderQueries: query.folderQueries.map(folder => ({ ...folder, folder: folder.folder.toString() })),
      }).toEqual({
        type: QueryType.File,
        folderQueries: [{ folder: 'file:///workspace', ignoreSymlinks: true }],
        filePattern: '',
        maxResults: 50,
      });
    });

    it('filters candidates by the query regardless of case', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.file('/workspace/src/Deep/a.ts') });
      expect((await createController(services).searchFiles('deep')).map(candidate => candidate.path)).toEqual([
        'src/Deep/a.ts',
        'src/Deep/',
      ]);
    });

    it('searches only the root named by the query in a multi-root workspace', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1, { name: 'one', uri: URI.file('/one') }, { name: 'two', uri: URI.file('/two') });
      services.search.fileSearch.mockResolvedValue({ results: [{ resource: URI.file('/two/b.ts') }] });
      const controller = createController(services);
      expect((await controller.searchFiles('two/b')).map(candidate => candidate.path)).toEqual(['two/b.ts']);
      await controller.searchFiles('b');
      const queries = services.search.fileSearch.mock.calls as unknown as [
        { folderQueries: { folder: URI }[]; filePattern: string },
      ][];
      expect(
        queries.map(([query]) => [query.filePattern, query.folderQueries.map(folder => folder.folder.toString())]),
      ).toEqual([
        ['b', ['file:///two']],
        ['b', ['file:///one', 'file:///two']],
      ]);
    });

    it('offers open untitled documents when the workspace has no file folders', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1, { name: 'remote', uri: URI.parse('vscode-remote://host/workspace') });
      services.models.push({ uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) });
      expect(await createController(services).searchFiles('')).toMatchObject([{ path: 'Untitled-1' }]);
      expect(services.search.fileSearch).not.toHaveBeenCalled();
    });

    it('tolerates a root folder without listed children', async () => {
      const services = controllerServices();
      services.stats.set('/workspace', {});
      expect(await createController(services).searchFiles('')).toMatchObject([{ path: './', name: 'workspace' }]);
    });

    it('stops climbing folders at the root of the file system', async () => {
      const services = controllerServices();
      const root = { name: 'server', uri: URI.from({ scheme: 'file', authority: 'server', path: '/' }) };
      services.folders.splice(0, 1);
      services.workspace.getWorkspaceFolder.mockReturnValue(root);
      services.adapter.contextPath.mockImplementation((uri: URI) => uri.path);
      services.models.push({ uri: URI.file('/a/b.ts') });
      expect((await createController(services).searchFiles('')).map(candidate => candidate.uri)).toEqual([
        'file:///a/b.ts',
        'file:///a',
        'file:///',
      ]);
    });
  });

  describe(GlyphContextController.prototype.selectFiles, () => {
    it('captures every file chosen in the open dialog', async () => {
      const services = controllerServices();
      services.dialogs.showOpenDialog.mockResolvedValue([URI.file('/workspace/a.ts'), URI.file('/workspace/b.ts')]);
      const controller = createController(services);
      expect((await controller.selectFiles()).map(attachment => attachment.path)).toEqual(['a.ts', 'b.ts']);
      expect(services.dialogs.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({ defaultUri: URI.file('/workspace'), canSelectMany: true }),
      );
    });

    it('captures nothing when the open dialog is dismissed', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1);
      expect(await createController(services).selectFiles()).toEqual([]);
      expect(services.dialogs.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultUri: undefined }));
    });
  });

  describe(GlyphContextController.prototype.captureFile, () => {
    it('refuses to capture in an untrusted workspace', async () => {
      const services = controllerServices();
      services.trust.isWorkspaceTrusted.mockReturnValue(false);
      await expect(createController(services).captureFile('file:///workspace/a.ts')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
        message: 'Trust this workspace before attaching context.',
      });
    });

    it('refuses a file that has been deleted', async () => {
      const services = controllerServices();
      services.files.exists.mockResolvedValue(false);
      await expect(createController(services).captureFile('file:///workspace/a.ts')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.NOT_FOUND,
      });
    });

    it('captures an open untitled document', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) });
      expect(await createController(services).captureFile('untitled:Untitled-1')).toMatchObject({ path: 'Untitled-1' });
      expect(services.files.exists).not.toHaveBeenCalled();
    });

    it('refuses a closed untitled document', async () => {
      const services = controllerServices();
      await expect(createController(services).captureFile('untitled:Untitled-1')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
      });
    });

    it('refuses an unopened file larger than the attachment limit', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/a.ts', { size: 512 * 1024 + 1 });
      await expect(createController(services).captureFile('file:///workspace/a.ts')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
      });
      expect(services.resolver.createModelReference).not.toHaveBeenCalled();
    });

    it('captures an unopened file of unknown size and releases its model', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/a.ts', {});
      expect(await createController(services).captureFile('file:///workspace/a.ts')).toMatchObject({ path: 'a.ts' });
      const reference = (await services.resolver.createModelReference.mock.results[0].value) as { dispose: Mock };
      expect(reference.dispose).toHaveBeenCalledOnce();
    });
  });

  describe(GlyphContextController.prototype.captureResources, () => {
    it.each([[[]], [Array.from({ length: 33 }, (_, index) => `file:///workspace/${index}.ts`)]])(
      'refuses to capture %j resources',
      async resources => {
        await expect(createController(controllerServices()).captureResources(resources)).rejects.toThrow(
          'Select between 1 and 32 files or folders to attach.',
        );
      },
    );

    it('captures each distinct file and folder once', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      expect(
        (
          await createController(services).captureResources([
            'file:///workspace/a.ts',
            'file:///workspace/src',
            'file:///workspace/a.ts',
          ])
        ).map(attachment => [attachment.kind, attachment.path]),
      ).toEqual([
        [GlyphContextAttachmentKind.FILE, 'a.ts'],
        [GlyphContextAttachmentKind.FOLDER, 'src'],
      ]);
    });
  });

  describe(GlyphContextController.prototype.captureFolder, () => {
    it('captures the search-visible outline of a nested folder', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src/deep', { isDirectory: true });
      services.search.fileSearch.mockResolvedValue({
        results: [
          { resource: URI.file('/workspace/src/deep/a.ts') },
          { resource: URI.file('/workspace/src/deep/inner/b.ts') },
          { resource: URI.file('/workspace/src/deeper.ts') },
        ],
        limitHit: true,
      });
      const attachment = await createController(services).captureFolder('file:///workspace/src/deep');
      expect(attachment).toMatchObject({
        kind: GlyphContextAttachmentKind.FOLDER,
        uri: 'file:///workspace/src/deep',
        path: 'src/deep',
        text: `Directory tree: src/deep\n(Search-visible paths; file contents are not included.)\n\n${formatFolderContextOutline(['a.ts', 'inner/b.ts'], true)}`,
      });
      expect(services.files.stat.mock.calls.map(([uri]) => uri.path)).toEqual([
        '/workspace/src/deep',
        '/workspace/src',
        '/workspace',
      ]);
    });

    it('names a workspace root after its folder', async () => {
      const services = controllerServices();
      services.stats.set('/workspace', { isDirectory: true });
      expect(await createController(services).captureFolder('file:///workspace')).toMatchObject({ path: 'workspace' });
    });

    it('names an unnamed workspace root as the current folder', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1, { name: '', uri: URI.file('/workspace') });
      services.stats.set('/workspace', { isDirectory: true });
      expect(await createController(services).captureFolder('file:///workspace')).toMatchObject({ path: '.' });
    });

    it('refuses folders that are not on disk', async () => {
      await expect(createController(controllerServices()).captureFolder('untitled:folder')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        message: 'Only workspace folders can be attached.',
      });
    });

    it('refuses disk folders outside the workspace', async () => {
      const services = controllerServices();
      services.workspace.getWorkspaceFolder.mockReturnValue(undefined);

      await expect(createController(services).captureFolder('file:///elsewhere')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        message: 'Only workspace folders can be attached.',
      });
    });

    it.each([
      ['a file', { isDirectory: false }],
      ['a symbolic link', { isDirectory: true, isSymbolicLink: true }],
    ])('refuses %s', async (_case, stat) => {
      const services = controllerServices();
      services.stats.set('/workspace/src', stat);
      await expect(createController(services).captureFolder('file:///workspace/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        message: 'Choose a workspace folder, not a symbolic link.',
      });
    });

    it('refuses a folder reached through a symbolic link', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/link/src', { isDirectory: true });
      services.stats.set('/workspace/link', { isDirectory: true, isSymbolicLink: true });
      await expect(createController(services).captureFolder('file:///workspace/link/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        message: 'Folder context cannot traverse symbolic links.',
      });
    });

    it('stops checking ancestors at the root of the file system', async () => {
      const services = controllerServices();
      const root = { name: 'server', uri: URI.from({ scheme: 'file', authority: 'server', path: '/' }) };
      services.workspace.getWorkspaceFolder.mockReturnValue(root);
      services.adapter.contextPath.mockImplementation((uri: URI) => uri.path);
      services.stats.set('/a/b', { isDirectory: true });
      services.stats.set('/a', { isDirectory: true });
      services.stats.set('/', { isDirectory: true });
      expect(await createController(services).captureFolder('file:///a/b')).toMatchObject({ path: '/a/b' });
      expect(services.files.stat.mock.calls.map(([uri]) => uri.toString())).toEqual([
        'file:///a/b',
        'file:///a',
        'file:///',
      ]);
    });

    it('refuses an outline larger than the attachment limit', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      services.search.fileSearch.mockResolvedValue({
        results: Array.from({ length: 1000 }, (_, index) => ({
          resource: URI.file(`/workspace/src/${String(index).padStart(600, '0')}.ts`),
        })),
      });
      await expect(createController(services).captureFolder('file:///workspace/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
      });
    });

    it('refuses a capture whose workspace path changed meanwhile', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      services.search.fileSearch.mockImplementation(async () => {
        services.folders.splice(0, 1, { name: 'other', uri: URI.file('/workspace/src') });
        return { results: [] };
      });
      await expect(createController(services).captureFolder('file:///workspace/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.STALE_DOCUMENT,
      });
    });

    it('refuses a capture whose workspace folder disappeared meanwhile', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      services.search.fileSearch.mockImplementation(async () => {
        services.folders.splice(0);
        return { results: [] };
      });

      await expect(createController(services).captureFolder('file:///workspace/src')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.STALE_DOCUMENT,
      });
    });
  });

  describe(GlyphContextController.prototype.refreshAttachment, () => {
    it('refuses to refresh an immutable IDE capture', async () => {
      await expect(
        createController(controllerServices()).refreshAttachment({
          kind: GlyphContextAttachmentKind.DIAGNOSTIC,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: 'old',
          contentRevision: 'old',
        }),
      ).rejects.toMatchObject({ code: GlyphDesktopErrorCode.STALE_DOCUMENT });
    });

    it('refreshes a folder outline and keeps its identity', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      const controller = createController(services);
      const folder = {
        kind: GlyphContextAttachmentKind.FOLDER,
        uri: 'file:///workspace/src',
        path: 'src',
        text: '',
        contentRevision: '',
      };
      expect(await controller.refreshAttachment({ ...folder, id: 'kept' })).toMatchObject({ id: 'kept', path: 'src' });
      expect((await controller.refreshAttachment(folder)).id).not.toBe('kept');
    });

    it('recaptures a selection and keeps its identity and side', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.file('/workspace/a.ts') });
      const range = { start: { line: 1, column: 1 }, end: { line: 1, column: 3 } };
      expect(
        await createController(services).refreshAttachment({
          id: 'kept',
          kind: GlyphContextAttachmentKind.SELECTION,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: 'old',
          contentRevision: 'old',
          range,
          side: 'original',
        }),
      ).toEqual({
        id: 'kept',
        kind: GlyphContextAttachmentKind.SELECTION,
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
        text: 'text',
        contentRevision: 'revision',
        range,
        side: 'original',
      });
    });

    it('recaptures a file as a fresh attachment', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.file('/workspace/a.ts') });
      expect(
        await createController(services).refreshAttachment({
          kind: GlyphContextAttachmentKind.FILE,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: 'old',
          contentRevision: 'old',
        }),
      ).toEqual({
        id: 'capture',
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
        text: 'text',
        contentRevision: 'revision',
      });
    });
  });

  describe(GlyphContextController.prototype.checkAttachment, () => {
    const token = {
      workspaceGeneration: 'generation',
      resource: 'file:///workspace/a.ts',
      incarnation: 'one',
      version: 1,
    };

    it('reports an attachment already marked unavailable', async () => {
      expect(
        await createController(controllerServices()).checkAttachment({
          kind: GlyphContextAttachmentKind.FILE,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: '',
          contentRevision: '',
          unavailable: 'Gone.',
        }),
      ).toBe('Gone.');
    });

    it('describes IDE captures and flags those whose source changed', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.file('/workspace/a.ts') });
      const controller = createController(services);
      const capture = {
        kind: GlyphContextAttachmentKind.DIAGNOSTIC,
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
        text: '',
        contentRevision: '',
      };
      const preserved =
        'Captured IDE context. Capture again from the originating surface to refresh; the original snapshot is preserved.';
      expect(await controller.checkAttachment({ ...capture, token })).toBe(preserved);
      services.adapter.isCurrentContext.mockReturnValue(false);
      expect(await controller.checkAttachment({ ...capture, token })).toBe(
        `Source changed; this capture is stale. ${preserved}`,
      );
      expect(await controller.checkAttachment(capture)).toBe(preserved);
      expect(await controller.checkAttachment({ ...capture, uri: 'file:///workspace/b.ts', token })).toBe(preserved);
    });

    it('reports a deleted source', async () => {
      const services = controllerServices();
      services.files.exists.mockResolvedValue(false);
      expect(
        await createController(services).checkAttachment({
          kind: GlyphContextAttachmentKind.FILE,
          uri: 'file:///workspace/a.ts',
          path: 'a.ts',
          text: '',
          contentRevision: '',
        }),
      ).toBe('Source deleted. The captured text is preserved.');
    });

    it('describes a folder outline', async () => {
      expect(
        await createController(controllerServices()).checkAttachment({
          kind: GlyphContextAttachmentKind.FOLDER,
          uri: 'file:///workspace/src',
          path: 'src',
          text: '',
          contentRevision: '',
        }),
      ).toBe('Captured folder outline. Refresh explicitly to update it.');
    });

    it('reports whether an open source still matches its capture', async () => {
      const services = controllerServices();
      services.models.push({ uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) });
      const controller = createController(services);
      const attachment = {
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'untitled:Untitled-1',
        path: 'Untitled-1',
        text: '',
        contentRevision: '',
        token,
      };
      expect(await controller.checkAttachment(attachment)).toBeUndefined();
      services.adapter.isCurrentContext.mockReturnValue(false);
      expect(await controller.checkAttachment(attachment)).toBe(
        'Source changed. Refresh explicitly to replace the captured text.',
      );
      expect(await controller.checkAttachment({ ...attachment, uri: 'untitled:Untitled-2' })).toBe(
        'Source closed. The captured text is preserved.',
      );
      expect(services.files.exists).not.toHaveBeenCalled();
    });
  });

  describe(GlyphContextController.prototype.rebindAttachment, () => {
    const attachment = {
      kind: GlyphContextAttachmentKind.FILE,
      path: 'old/a.ts',
      text: 'text',
      contentRevision: 'revision',
      token: { workspaceGeneration: 'generation', resource: 'file:///workspace/a.ts', incarnation: 'one', version: 1 },
      unavailable: 'Earlier problem.',
    };

    it('keeps untitled captures without their token', () => {
      expect(
        createController(controllerServices()).rebindAttachment({ ...attachment, uri: 'untitled:Untitled-1' }),
      ).toEqual({
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'untitled:Untitled-1',
        path: 'old/a.ts',
        text: 'text',
        contentRevision: 'revision',
      });
    });

    it('marks captures of other resources unavailable', () => {
      expect(
        createController(controllerServices()).rebindAttachment({
          ...attachment,
          uri: 'vscode-test-data://results/run',
        }),
      ).toMatchObject({ unavailable: 'Workspace changed. Capture this context again before sending.' });
    });

    it('marks captures outside of the workspace unavailable', () => {
      expect(
        createController(controllerServices()).rebindAttachment({ ...attachment, uri: 'file:///elsewhere/a.ts' }),
      ).toMatchObject({
        unavailable: 'Source folder was removed. Remove this attachment or add its folder again before sending.',
      });
    });

    it('renames workspace captures to their current path', () => {
      const rebound = createController(controllerServices()).rebindAttachment({
        ...attachment,
        uri: 'file:///workspace/a.ts',
      });
      expect(rebound).toEqual({
        kind: GlyphContextAttachmentKind.FILE,
        uri: 'file:///workspace/a.ts',
        path: 'a.ts',
        text: 'text',
        contentRevision: 'revision',
      });
    });
  });

  describe(GlyphContextController.prototype.openAttachment, () => {
    it('leaves sources that the IDE context opens to it', async () => {
      const services = controllerServices();
      services.ide.openSource.mockResolvedValue(true);
      await createController(services).openAttachment({ path: 'Terminal 1', uri: 'glyph-terminal:/id/1' });
      expect(services.editors.openEditor).not.toHaveBeenCalled();
    });

    it('opens a workspace path at its captured range', async () => {
      const services = controllerServices();
      const controller = createController(services);
      await controller.openAttachment({
        path: 'src/a.ts',
        range: { start: { line: 1, column: 2 }, end: { line: 3, column: 4 } },
      });
      await controller.openAttachment({ path: 'src/a.ts' });
      expect(services.editors.openEditor.mock.calls).toEqual([
        [
          {
            resource: URI.file('/workspace/src/a.ts'),
            options: {
              pinned: true,
              selection: { startLineNumber: 1, startColumn: 2, endLineNumber: 3, endColumn: 4 },
            },
          },
        ],
        [{ resource: URI.file('/workspace/src/a.ts'), options: { pinned: true } }],
      ]);
      expect(services.ide.openSource).not.toHaveBeenCalled();
    });

    it('opens a path under its root in a multi-root workspace', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1, { name: 'one', uri: URI.file('/one') }, { name: 'two', uri: URI.file('/two') });
      await createController(services).openAttachment({ path: 'two/src/a.ts' });
      expect(services.editors.openEditor).toHaveBeenCalledWith({
        resource: URI.file('/two/src/a.ts'),
        options: { pinned: true },
      });
    });

    it.each(['three/a.ts', 'one/../a.ts', 'one//etc/passwd', 'one/c:/a.ts'])(
      'refuses the unavailable multi-root path %s',
      async path => {
        const services = controllerServices();
        services.folders.splice(0, 1, { name: 'one', uri: URI.file('/one') }, { name: 'two', uri: URI.file('/two') });
        await expect(createController(services).openAttachment({ path })).rejects.toMatchObject({
          code: GlyphDesktopErrorCode.NOT_FOUND,
          message: 'The attachment source is unavailable in this workspace.',
        });
      },
    );

    it('refuses a path when the workspace has no file folders', async () => {
      const services = controllerServices();
      services.folders.splice(0, 1);
      await expect(createController(services).openAttachment({ path: 'a.ts' })).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.NOT_FOUND,
      });
    });

    it('refuses a deleted source', async () => {
      const services = controllerServices();
      services.files.exists.mockResolvedValue(false);
      await expect(
        createController(services).openAttachment({ path: 'a.ts', uri: 'file:///workspace/a.ts' }),
      ).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.NOT_FOUND,
        message: 'Source deleted. The captured text is preserved.',
      });
    });

    it('opens an untitled source only while it is open', async () => {
      const services = controllerServices();
      const controller = createController(services);
      await expect(controller.openAttachment({ path: 'Untitled-1', uri: 'untitled:Untitled-1' })).rejects.toMatchObject(
        {
          code: GlyphDesktopErrorCode.NOT_FOUND,
          message: 'The untitled source is closed. The captured text is preserved.',
        },
      );
      services.models.push({ uri: URI.from({ scheme: 'untitled', path: 'Untitled-1' }) });
      await controller.openAttachment({ path: 'Untitled-1', uri: 'untitled:Untitled-1' });
      expect(services.editors.openEditor).toHaveBeenCalledWith({
        resource: expect.objectContaining({ scheme: 'untitled', path: 'Untitled-1' }),
        options: { pinned: true },
      });
    });

    it('reveals a folder in the explorer', async () => {
      const services = controllerServices();
      services.stats.set('/workspace/src', { isDirectory: true });
      await createController(services).openAttachment({ path: 'src', uri: 'file:///workspace/src' });
      expect(services.commands.executeCommand).toHaveBeenCalledWith('revealInExplorer', URI.file('/workspace/src'));
      expect(services.editors.openEditor).not.toHaveBeenCalled();
    });
  });
});
