import { GlyphIdeContext } from './GlyphIdeContext.js';
import { IInstantiationService } from '#vs/platform/instantiation/common/instantiation.js';
import { dirname } from '#vs/base/common/resources.js';
import { generateUuid } from '#vs/base/common/uuid.js';
import { formatFolderContextOutline } from '#glyph/workbench/formatFolderContextOutline.js';
import { GlyphContextAttachmentKind } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import { GlyphContextCandidateKind } from '#glyph/workbench/GlyphContextActions.js';
import type { GlyphAttachmentPreview } from '#glyph/protocol/events/GlyphAttachmentPreview.js';
import { Disposable } from '#vs/base/common/lifecycle.js';
import { URI } from '#vs/base/common/uri.js';
import { isCodeEditor, isDiffEditor, type ICodeEditor } from '#vs/editor/browser/editorBrowser.js';
import { IEditorService } from '#vs/workbench/services/editor/common/editorService.js';
import { ICodeEditorService } from '#vs/editor/browser/services/codeEditorService.js';
import type { ITextModel } from '#vs/editor/common/model.js';
import { IModelService } from '#vs/editor/common/services/model.js';
import { ITextModelService } from '#vs/editor/common/services/resolverService.js';
import { IWorkspaceContextService } from '#vs/platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '#vs/platform/workspace/common/workspaceTrust.js';
import { ISearchService, QueryType } from '#vs/workbench/services/search/common/search.js';
import { IFileService } from '#vs/platform/files/common/files.js';
import { ICommandService } from '#vs/platform/commands/common/commands.js';
import { IFileDialogService } from '#vs/platform/dialogs/common/dialogs.js';
import { getGlyphWorkspaceRootId } from '#glyph/protocol/connection/getGlyphWorkspaceRootId.js';
import { GlyphContextError } from './GlyphContextError.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import type { GlyphContextAttachment } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import type { GlyphContextActions, GlyphContextCandidate } from '#glyph/workbench/GlyphContextActions.js';
import type { GlyphComposerState } from '#glyph/workbench/GlyphComposerState.js';
import type { GlyphEditorAdapter } from './GlyphEditorAdapter.js';

/** Capture context only from explicit file selection, search, or selected editor text. */
export class GlyphContextController extends Disposable implements GlyphContextActions {
  readonly ide: GlyphIdeContext;
  private focused: ICodeEditor | undefined;
  constructor(
    private readonly adapter: GlyphEditorAdapter,
    private readonly composer: () => GlyphComposerState,
    @IEditorService private readonly editors: IEditorService,
    @ICodeEditorService codeEditors: ICodeEditorService,
    @IModelService private readonly models: IModelService,
    @ITextModelService private readonly resolver: ITextModelService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
    @ISearchService private readonly search: ISearchService,
    @IFileService private readonly files: IFileService,
    @IFileDialogService private readonly dialogs: IFileDialogService,
    @ICommandService private readonly commands: ICommandService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
    this.ide = instantiation.createInstance(GlyphIdeContext, adapter);
    const watch = (editor: ICodeEditor) =>
      this._register(
        editor.onDidFocusEditorText(() => {
          this.focused = editor;
        }),
      );
    for (const editor of codeEditors.listCodeEditors()) watch(editor);
    this._register(codeEditors.onCodeEditorAdd(watch));
  }
  selectIdeContext(): Promise<readonly GlyphContextAttachment[]> {
    return this.ide.select(this.activeEditor());
  }
  async attachSelection(): Promise<void> {
    this.assertTrusted();
    const composer = this.composer();
    const editor = this.activeEditor();
    const model = editor?.getModel();
    const selections = editor?.getSelections()?.filter(selection => !selection.isEmpty()) ?? [];
    if (!model || !selections.length)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.INVALID_REQUEST,
        'Highlight text in an editor before attaching a selection.',
      );
    if (model.uri.scheme === 'vscode-test-data') {
      composer.insertAttachments(
        await Promise.all(selections.map(selection => this.ide.captureTestSelection(model, selection))),
      );
      return;
    }
    const control = this.editors.activeTextEditorControl;
    const side = isDiffEditor(control) ? (editor === control.getOriginalEditor() ? 'original' : 'modified') : undefined;
    const attachments = await Promise.all(
      selections.map(selection =>
        this.adapter.captureContext(model, {
          start: { line: selection.startLineNumber, column: selection.startColumn },
          end: { line: selection.endLineNumber, column: selection.endColumn },
        }),
      ),
    );
    composer.insertAttachments(attachments.map(attachment => ({ ...attachment, ...(side ? { side } : {}) })));
  }
  async searchFiles(query: string): Promise<readonly GlyphContextCandidate[]> {
    this.assertTrusted();
    const folders = this.workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === 'file');
    const roots = folders.map(folder => ({ name: folder.name, uri: folder.uri.toString() }));
    const rootPrefix =
      roots.length > 1
        ? roots.map(root => getGlyphWorkspaceRootId(root, roots)).find(root => query.startsWith(`${root}/`))
        : undefined;
    const filePattern = rootPrefix ? query.slice(rootPrefix.length + 1) : query;
    const searchedFolders = rootPrefix
      ? folders.filter((_folder, index) => getGlyphWorkspaceRootId(roots[index], roots) === rootPrefix)
      : folders;
    const result = searchedFolders.length
      ? await this.search.fileSearch({
          type: QueryType.File,
          folderQueries: searchedFolders.map(folder => ({ folder: folder.uri, ignoreSymlinks: true })),
          filePattern,
          maxResults: 50,
        })
      : { results: [] };
    const resources = [
      ...this.models.getModels().map(model => model.uri),
      ...result.results.map(match => match.resource),
    ];
    const seen = new Set<string>();
    const candidates: GlyphContextCandidate[] = [];
    const add = (uri: URI, kind: GlyphContextCandidateKind, name?: string) => {
      if (seen.has(uri.toString())) return;
      const rawPath = this.adapter.contextPath(uri);
      const path = kind === GlyphContextCandidateKind.FOLDER ? `${rawPath.replace(/\/$/, '') || '.'}/` : rawPath;
      if (!`${path} ${name ?? ''}`.toLowerCase().includes(query.toLowerCase())) return;
      seen.add(uri.toString());
      candidates.push({
        uri: uri.toString(),
        path,
        kind,
        ...(name ? { name } : {}),
        ancestry: (kind === GlyphContextCandidateKind.FOLDER && name ? uri.path : rawPath).split('/').filter(Boolean),
      });
    };
    for (const uri of resources) {
      if (!['file', 'untitled'].includes(uri.scheme)) continue;
      try {
        add(uri, GlyphContextCandidateKind.FILE);
        const root = this.workspace.getWorkspaceFolder(uri);
        if (!root || uri.scheme !== 'file') continue;
        let parent = dirname(uri);
        while (parent.path.length >= root.uri.path.length) {
          add(
            parent,
            GlyphContextCandidateKind.FOLDER,
            parent.toString() === root.uri.toString() ? root.name : undefined,
          );
          if (parent.toString() === root.uri.toString()) break;
          const next = dirname(parent);
          if (next.path === parent.path) break;
          parent = next;
        }
      } catch {
        /* Closed or out-of-workspace models are not context candidates. */
      }
    }
    // Include root-level empty folders, which cannot be inferred from file search.
    for (const root of searchedFolders) {
      add(root.uri, GlyphContextCandidateKind.FOLDER, root.name);
      const stat = await this.files.resolve(root.uri);
      for (const child of stat.children ?? [])
        if (child.isDirectory && !child.isSymbolicLink) add(child.resource, GlyphContextCandidateKind.FOLDER);
    }
    return candidates.slice(0, 50);
  }
  async selectFiles(): Promise<readonly GlyphContextAttachment[]> {
    this.assertTrusted();
    const selected = await this.dialogs.showOpenDialog({
      title: 'Attach files to Glyph',
      openLabel: 'Attach',
      defaultUri: this.workspace.getWorkspace().folders[0]?.uri,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      availableFileSystems: ['file'],
    });
    return Promise.all((selected ?? []).map(uri => this.captureFile(uri.toString())));
  }
  captureFile(value: string): Promise<GlyphContextAttachment> {
    return this.withModel(value, model => this.adapter.captureContext(model));
  }

  async captureResources(resources: readonly string[]): Promise<readonly GlyphContextAttachment[]> {
    this.assertTrusted();
    const selected = [...new Set(resources)];
    if (!selected.length || selected.length > 32)
      throw new Error('Select between 1 and 32 files or folders to attach.');
    return Promise.all(
      selected.map(async value => {
        const uri = URI.parse(value);
        this.adapter.contextPath(uri);
        const stat = await this.files.stat(uri);
        return stat.isDirectory ? this.captureFolder(value) : this.captureFile(value);
      }),
    );
  }

  async captureFolder(value: string): Promise<GlyphContextAttachment> {
    this.assertTrusted();
    const uri = URI.parse(value);
    const path = this.adapter.contextPath(uri) || this.workspace.getWorkspaceFolder(uri)?.name || '.';
    if (uri.scheme !== 'file')
      throw new GlyphContextError(
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        'Only workspace folders can be attached.',
      );
    const stat = await this.files.stat(uri);
    if (!stat.isDirectory || stat.isSymbolicLink)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        'Choose a workspace folder, not a symbolic link.',
      );
    const workspaceFolder = this.workspace.getWorkspaceFolder(uri)!;
    let ancestor = dirname(uri);
    while (ancestor.path.length >= workspaceFolder.uri.path.length && ancestor.toString() !== uri.toString()) {
      if ((await this.files.stat(ancestor)).isSymbolicLink)
        throw new GlyphContextError(
          GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
          'Folder context cannot traverse symbolic links.',
        );
      if (ancestor.toString() === workspaceFolder.uri.toString()) break;
      const parent = dirname(ancestor);
      if (parent.path === ancestor.path) break;
      ancestor = parent;
    }
    const result = await this.search.fileSearch({
      type: QueryType.File,
      folderQueries: [{ folder: uri, ignoreSymlinks: true }],
      maxResults: 1000,
    });
    const prefix = `${uri.path.replace(/\/$/, '')}/`;
    const paths = result.results
      .filter(match => match.resource.path.startsWith(prefix))
      .map(match => match.resource.path.slice(prefix.length));
    const text = `Directory tree: ${path}\n(Search-visible paths; file contents are not included.)\n\n${formatFolderContextOutline(paths, result.limitHit)}`;
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > 512 * 1024)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
        'This folder outline exceeds the attachment limit. Choose a smaller folder.',
      );
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const contentRevision = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    this.assertTrusted();
    if ((this.adapter.contextPath(uri) || this.workspace.getWorkspaceFolder(uri)?.name || '.') !== path)
      throw new GlyphContextError(GlyphDesktopErrorCode.STALE_DOCUMENT, 'The workspace changed during capture.');
    return { id: generateUuid(), kind: GlyphContextAttachmentKind.FOLDER, uri: value, path, text, contentRevision };
  }
  async refreshAttachment(attachment: GlyphContextAttachment): Promise<GlyphContextAttachment> {
    if (!['file', 'selection', 'folder'].includes(attachment.kind))
      throw new GlyphContextError(
        GlyphDesktopErrorCode.STALE_DOCUMENT,
        'IDE captures are immutable. Use Attach IDE context to capture a fresh result.',
      );
    if (attachment.kind === GlyphContextAttachmentKind.FOLDER)
      return { ...(await this.captureFolder(attachment.uri)), ...(attachment.id ? { id: attachment.id } : {}) };
    return this.withModel(attachment.uri, async model => ({
      ...(await this.adapter.captureContext(model, attachment.range)),
      ...(attachment.id ? { id: attachment.id } : {}),
      ...(attachment.side ? { side: attachment.side } : {}),
    }));
  }
  async checkAttachment(attachment: GlyphContextAttachment): Promise<string | undefined> {
    if (!['file', 'selection', 'folder'].includes(attachment.kind)) {
      const model = this.models.getModel(URI.parse(attachment.uri));
      return `${attachment.token && model && !this.adapter.isCurrentContext(model, attachment) ? 'Source changed; this capture is stale. ' : ''}Captured IDE context. Capture again from the originating surface to refresh; the original snapshot is preserved.`;
    }
    const uri = URI.parse(attachment.uri);
    if (uri.scheme === 'file' && !(await this.files.exists(uri)))
      return 'Source deleted. The captured text is preserved.';
    if (attachment.kind === GlyphContextAttachmentKind.FOLDER)
      return 'Captured folder outline. Refresh explicitly to update it.';
    const model = this.models.getModel(uri);
    if (!model) return 'Source closed. The captured text is preserved.';
    if (!this.adapter.isCurrentContext(model, attachment))
      return 'Source changed. Refresh explicitly to replace the captured text.';
    return undefined;
  }
  async openAttachment(attachment: Pick<GlyphAttachmentPreview, 'path' | 'uri' | 'range'>): Promise<void> {
    if (attachment.uri && (await this.ide.openSource(URI.parse(attachment.uri), this.editors, attachment.range)))
      return;
    const folders = this.workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === 'file');
    const roots = folders.map(folder => ({ name: folder.name, uri: folder.uri.toString() }));
    const folder =
      folders.length === 1
        ? folders[0]
        : folders.find(candidate =>
            attachment.path.startsWith(
              `${getGlyphWorkspaceRootId({ name: candidate.name, uri: candidate.uri.toString() }, roots)}/`,
            ),
          );
    const relative = folders.length > 1 ? attachment.path.slice(attachment.path.indexOf('/') + 1) : attachment.path;
    if (!attachment.uri && (!folder || /^(?:[a-z]+:|[/\\])|(?:^|[/\\])\.\.(?:[/\\]|$)/i.test(relative)))
      throw new GlyphContextError(
        GlyphDesktopErrorCode.NOT_FOUND,
        'The attachment source is unavailable in this workspace.',
      );
    const uri = attachment.uri ? URI.parse(attachment.uri) : URI.joinPath(folder!.uri, relative);
    this.adapter.contextPath(uri);
    if (uri.scheme === 'file' && !(await this.files.exists(uri)))
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'Source deleted. The captured text is preserved.');
    if (uri.scheme === 'untitled' && !this.models.getModel(uri))
      throw new GlyphContextError(
        GlyphDesktopErrorCode.NOT_FOUND,
        'The untitled source is closed. The captured text is preserved.',
      );
    if (uri.scheme === 'file' && (await this.files.stat(uri)).isDirectory) {
      await this.commands.executeCommand('revealInExplorer', uri);
      return;
    }
    await this.editors.openEditor({
      resource: uri,
      options: {
        pinned: true,
        ...(attachment.range
          ? {
              selection: {
                startLineNumber: attachment.range.start.line,
                startColumn: attachment.range.start.column,
                endLineNumber: attachment.range.end.line,
                endColumn: attachment.range.end.column,
              },
            }
          : {}),
      },
    });
  }
  private activeEditor(): ICodeEditor | undefined {
    const control = this.editors.activeTextEditorControl;
    if (isDiffEditor(control))
      return this.focused === control.getOriginalEditor() ? control.getOriginalEditor() : control.getModifiedEditor();
    return isCodeEditor(control) ? control : undefined;
  }
  private assertTrusted(): void {
    if (!this.trust.isWorkspaceTrusted())
      throw new GlyphContextError(
        GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
        'Trust this workspace before attaching context.',
      );
  }
  private async withModel<T>(value: string, capture: (model: ITextModel) => Promise<T>): Promise<T> {
    this.assertTrusted();
    const uri = URI.parse(value);
    this.adapter.contextPath(uri);
    if (uri.scheme === 'file' && !(await this.files.exists(uri)))
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'The source file has been deleted.');
    const existing = this.models.getModel(uri);
    if (existing) return capture(existing);
    if (uri.scheme !== 'file')
      throw new GlyphContextError(GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE, 'This resource cannot be attached.');
    const stat = await this.files.stat(uri);
    if ((stat.size ?? 0) > 512 * 1024)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
        'This file exceeds the 512 KiB attachment limit. Select a smaller passage.',
      );
    const reference = await this.resolver.createModelReference(uri);
    try {
      return await capture(reference.object.textEditorModel);
    } finally {
      reference.dispose();
    }
  }
}
