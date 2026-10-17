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
import { getGlyphWorkspaceRootId } from '#glyph/protocol/connection/getGlyphWorkspaceRootId.js';
import { GlyphContextError } from './GlyphContextError.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import type { GlyphContextAttachment } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import type { GlyphContextActions, GlyphContextCandidate } from '#glyph/workbench/GlyphContextActions.js';
import type { GlyphComposerState } from '#glyph/workbench/GlyphComposerState.js';
import type { GlyphEditorAdapter } from './GlyphEditorAdapter.js';

/** Editor captures are explicit immutable data; focus updates only the suggestion. */
export class GlyphContextController extends Disposable implements GlyphContextActions {
  private focused: ICodeEditor | undefined;
  constructor(
    private readonly adapter: GlyphEditorAdapter,
    private readonly composer: () => GlyphComposerState,
    private readonly changed: () => void,
    @IEditorService private readonly editors: IEditorService,
    @ICodeEditorService codeEditors: ICodeEditorService,
    @IModelService private readonly models: IModelService,
    @ITextModelService private readonly resolver: ITextModelService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IWorkspaceTrustManagementService private readonly trust: IWorkspaceTrustManagementService,
    @ISearchService private readonly search: ISearchService,
    @IFileService private readonly files: IFileService,
  ) {
    super();
    const watch = (editor: ICodeEditor) =>
      this._register(
        editor.onDidFocusEditorText(() => {
          this.focused = editor;
          this.changed();
        }),
      );
    for (const editor of codeEditors.listCodeEditors()) watch(editor);
    this._register(codeEditors.onCodeEditorAdd(watch));
    this._register(editors.onDidActiveEditorChange(() => this.changed()));
  }
  private activeEditor(): ICodeEditor | undefined {
    const control = this.editors.activeTextEditorControl;
    if (isDiffEditor(control))
      return this.focused === control.getOriginalEditor() ? control.getOriginalEditor() : control.getModifiedEditor();
    return isCodeEditor(control) ? control : undefined;
  }
  get active(): GlyphContextCandidate | undefined {
    const model = this.activeEditor()?.getModel();
    if (!model) return undefined;
    try {
      return { uri: model.uri.toString(), path: this.adapter.contextPath(model.uri) };
    } catch {
      return { uri: model.uri.toString(), path: model.uri.path, detail: 'This resource cannot be attached.' };
    }
  }
  private assertTrusted(): void {
    if (!this.trust.isWorkspaceTrusted())
      throw new GlyphContextError(
        GlyphDesktopErrorCode.UNTRUSTED_WORKSPACE,
        'Trust this workspace before attaching context.',
      );
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
    return resources
      .flatMap(uri => {
        if (!['file', 'untitled'].includes(uri.scheme) || seen.has(uri.toString())) return [];
        seen.add(uri.toString());
        try {
          const path = this.adapter.contextPath(uri);
          return path.toLowerCase().includes(query.toLowerCase()) ? [{ uri: uri.toString(), path }] : [];
        } catch {
          return [];
        }
      })
      .slice(0, 50);
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
  captureFile(value: string): Promise<GlyphContextAttachment> {
    return this.withModel(value, model => this.adapter.captureContext(model));
  }
  refreshAttachment(attachment: GlyphContextAttachment): Promise<GlyphContextAttachment> {
    return this.withModel(attachment.uri, async model => ({
      ...(await this.adapter.captureContext(model, attachment.range)),
      ...(attachment.id ? { id: attachment.id } : {}),
      ...(attachment.side ? { side: attachment.side } : {}),
    }));
  }
  async checkAttachment(attachment: GlyphContextAttachment): Promise<string | undefined> {
    const uri = URI.parse(attachment.uri);
    if (uri.scheme === 'file' && !(await this.files.exists(uri)))
      return 'Source deleted. The captured text is preserved.';
    const model = this.models.getModel(uri);
    if (!model) return 'Source closed. The captured text is preserved.';
    if (!this.adapter.isCurrentContext(model, attachment))
      return 'Source changed. Refresh explicitly to replace the captured text.';
    return undefined;
  }
  async openAttachment(attachment: GlyphContextAttachment): Promise<void> {
    const uri = URI.parse(attachment.uri);
    if (uri.scheme === 'file' && !(await this.files.exists(uri)))
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'Source deleted. The captured text is preserved.');
    if (uri.scheme === 'untitled' && !this.models.getModel(uri))
      throw new GlyphContextError(
        GlyphDesktopErrorCode.NOT_FOUND,
        'The untitled source is closed. The captured text is preserved.',
      );
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
}
