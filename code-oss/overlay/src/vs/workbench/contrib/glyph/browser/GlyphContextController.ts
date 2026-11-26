import { Emitter } from '#vs/base/common/event.js';
import { RunOnceScheduler } from '#vs/base/common/async.js';
import { DisposableStore, DisposableMap, MutableDisposable, type IDisposable } from '#vs/base/common/lifecycle.js';
import type { GlyphSkill } from '#glyph/protocol/events/GlyphSkill.js';
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
import type { GlyphInstructionSource } from '#glyph/protocol/events/GlyphInstructionSource.js';

/** Capture context only from explicit file selection, search, or selected editor text. */
export class GlyphContextController extends Disposable implements GlyphContextActions {
  private readonly instructionsChanged = this._register(new Emitter<void>());
  private readonly skillWatchers = this._register(new DisposableStore());
  private readonly rootWatches = this._register(new DisposableMap<string>());
  private skillRoots: () => readonly string[] = () => [];
  private watchSkillModel: ((model: ITextModel) => void) | undefined;
  private instructionFingerprint = '';
  private refreshSkillSources: (() => Promise<void>) | undefined;
  private skillSources: () => readonly GlyphSkill[] = () => [];
  readonly ide: GlyphIdeContext;
  private focused: ICodeEditor | undefined;
  constructor(
    private readonly adapter: GlyphEditorAdapter,
    private readonly composer: () => GlyphComposerState,
    private readonly instructionSources: () => readonly GlyphInstructionSource[],
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
  setSkillSources(
    source: () => readonly GlyphSkill[],
    refresh?: () => Promise<void>,
    roots?: () => readonly string[],
  ): void {
    this.skillRoots = roots ?? (() => []);
    this.rootWatches.clearAndDisposeAll();
    this.skillSources = source;
    this.refreshSkillSources = refresh;
    this.skillWatchers.clear();
    if (!refresh) return;
    const followup = this.skillWatchers.add(
      new RunOnceScheduler(() => {
        if (this.trust.isWorkspaceTrusted()) void refresh().catch(() => {});
      }, 1000),
    );
    const changed = this.skillWatchers.add(
      new RunOnceScheduler(() => {
        if (!this.trust.isWorkspaceTrusted()) return;
        void refresh().catch(() => {});
        followup.schedule();
      }, 300),
    );
    const relevant = (uri: URI) =>
      /\/\.(?:glyph|cursor)(?:\/(?:skills|rules)(?:\/|$)|$)/iu.test(uri.path) ||
      /\/AGENTS\.md$/iu.test(uri.path) ||
      this.instructionSources().some(instruction => {
        if (instruction.uri === uri.toString()) return true;
        if (!instruction.references?.length) return false;
        try {
          const path = this.adapter.contextPath(uri);
          return instruction.references.includes(path);
        } catch {
          return (
            instruction.kind === 'glyph_user_rule' &&
            instruction.uri !== undefined &&
            instruction.references.some(
              path => URI.joinPath(dirname(dirname(URI.parse(instruction.uri!))), path).toString() === uri.toString(),
            )
          );
        }
      }) ||
      this.skillRoots().some(root => {
        const path = URI.parse(root).path;
        return uri.path === path || uri.path.startsWith(`${path}/`);
      });
    const providerChanges = this.skillWatchers.add(new MutableDisposable<IDisposable>());
    const observeProvider = () => {
      providerChanges.value = this.files.getProvider('file')?.onDidChangeFile(changes => {
        if (changes.some(change => relevant(change.resource))) changed.schedule();
      });
    };
    observeProvider();
    this.skillWatchers.add(
      this.files.onDidChangeFileSystemProviderRegistrations(event => {
        if (event.scheme === 'file') observeProvider();
      }),
    );
    const watched = new WeakSet<ITextModel>();
    const watch = (model: ITextModel) => {
      if (!watched.has(model) && relevant(model.uri)) {
        watched.add(model);
        this.skillWatchers.add(
          model.onDidChangeContent(() => {
            changed.schedule();
          }),
        );
      }
    };
    this.watchSkillModel = watch;
    for (const model of this.models.getModels()) watch(model);
    this.skillWatchers.add(this.models.onModelAdded(watch));
  }
  onDidChangeInstructions(listener: () => void): () => void {
    const subscription = this.instructionsChanged.event(listener);
    return () => {
      subscription.dispose();
    };
  }
  notifyInstructionsChanged(): void {
    const roots = new Set(this.skillRoots());
    for (const root of this.rootWatches.keys()) if (!roots.has(root)) this.rootWatches.deleteAndDispose(root);
    for (const root of roots)
      if (!this.rootWatches.has(root))
        this.rootWatches.set(root, this.files.watch(URI.parse(root), { recursive: true, excludes: [] }));
    for (const model of this.models.getModels()) this.watchSkillModel?.(model);
    const fingerprint = JSON.stringify([this.skillSources(), this.instructionSources()]);
    if (fingerprint !== this.instructionFingerprint) {
      this.instructionFingerprint = fingerprint;
      this.instructionsChanged.fire();
    }
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
    if (!model || selections.length === 0)
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
    const filePattern = rootPrefix !== undefined && rootPrefix !== '' ? query.slice(rootPrefix.length + 1) : query;
    const searchedFolders =
      rootPrefix !== undefined && rootPrefix !== ''
        ? folders.filter((_folder, index) => getGlyphWorkspaceRootId(roots[index], roots) === rootPrefix)
        : folders;
    const result =
      searchedFolders.length > 0
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
      const path = kind === GlyphContextCandidateKind.FOLDER ? `${rawPath.replace(/\/$/u, '') || '.'}/` : rawPath;
      if (!`${path} ${name ?? ''}`.toLowerCase().includes(query.toLowerCase())) return;
      seen.add(uri.toString());
      candidates.push({
        uri: uri.toString(),
        path,
        kind,
        ...(name !== undefined && name !== '' ? { name } : {}),
        ancestry: (kind === GlyphContextCandidateKind.FOLDER && name !== undefined && name !== '' ? uri.path : rawPath)
          .split('/')
          .filter(Boolean),
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
  async searchInstructions(query: string): Promise<readonly GlyphContextCandidate[]> {
    this.assertTrusted();
    await this.refreshSkillSources?.();
    this.assertTrusted();
    const normalized = query.toLowerCase();
    const rules = this.instructionSources()
      .filter(rule => rule.activation === 'manual' && rule.status === 'active' && rule.enabled !== false)
      .filter(rule => {
        const name = rule.name ?? rule.path.split('/').at(-1)!;
        return `${name} ${rule.description ?? ''} ${rule.path}`.toLowerCase().includes(normalized);
      })
      .slice(0, 50)
      .map(rule => {
        const name = rule.name ?? rule.path.split('/').at(-1)!;
        return {
          uri: `glyph-rule:${encodeURIComponent(rule.id)}`,
          path: name,
          name,
          detail: rule.description ?? rule.path,
          kind: GlyphContextCandidateKind.RULE,
          ruleId: rule.id,
          ...(rule.revision ? { revision: rule.revision } : {}),
        };
      });
    const skills = this.skillSources()
      .filter(skill => skill.enabled && skill.status === 'active')
      .filter(skill =>
        `${skill.name} ${skill.description} ${skill.origin.label} ${skill.scope} ${skill.path}`
          .toLowerCase()
          .includes(normalized),
      )
      .map(skill => ({
        uri: `glyph-skill:${encodeURIComponent(skill.id)}`,
        path: skill.name,
        name: skill.name,
        detail: `${skill.path} · ${skill.origin.label} · ${skill.description}`,
        ancestry: [skill.origin.label, ...skill.path.split('/')],
        kind: GlyphContextCandidateKind.SKILL,
        skillId: skill.id,
        ...(skill.revision ? { revision: skill.revision } : {}),
      }));
    return [...rules, ...skills].slice(0, 50);
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
    if (selected.length === 0 || selected.length > 32)
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
    if (uri.scheme !== 'file')
      throw new GlyphContextError(
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        'Only workspace folders can be attached.',
      );
    const workspaceFolder = this.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        'Only workspace folders can be attached.',
      );
    const path = this.adapter.contextPath(uri) || workspaceFolder.name || '.';
    const stat = await this.files.stat(uri);
    if (!stat.isDirectory || stat.isSymbolicLink)
      throw new GlyphContextError(
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        'Choose a workspace folder, not a symbolic link.',
      );
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
    const prefix = `${uri.path.replace(/\/$/u, '')}/`;
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
    const currentWorkspaceFolder = this.workspace.getWorkspaceFolder(uri);
    if (!currentWorkspaceFolder || (this.adapter.contextPath(uri) || currentWorkspaceFolder.name || '.') !== path)
      throw new GlyphContextError(GlyphDesktopErrorCode.STALE_DOCUMENT, 'The workspace changed during capture.');
    return { id: generateUuid(), kind: GlyphContextAttachmentKind.FOLDER, uri: value, path, text, contentRevision };
  }
  async refreshAttachment(attachment: GlyphContextAttachment): Promise<GlyphContextAttachment> {
    if (attachment.kind === GlyphContextAttachmentKind.SKILL || attachment.kind === GlyphContextAttachmentKind.RULE) {
      this.assertTrusted();
      const source = this.referenceSource(attachment.uri);
      if (!source || source.status !== 'active' || source.enabled === false)
        throw new GlyphContextError(
          GlyphDesktopErrorCode.NOT_FOUND,
          'Selected instruction is unavailable. Choose it again.',
        );
      const { unavailable: _, ...reference } = attachment;
      return { ...reference, path: source.name ?? reference.path, contentRevision: source.revision ?? source.id };
    }

    if (!['file', 'selection', 'folder'].includes(attachment.kind))
      throw new GlyphContextError(
        GlyphDesktopErrorCode.STALE_DOCUMENT,
        'IDE captures are immutable. Use Attach IDE context to capture a fresh result.',
      );
    if (attachment.kind === GlyphContextAttachmentKind.FOLDER)
      return {
        ...(await this.captureFolder(attachment.uri)),
        ...(attachment.id !== undefined && attachment.id !== '' ? { id: attachment.id } : {}),
      };
    return this.withModel(attachment.uri, async model => ({
      ...(await this.adapter.captureContext(model, attachment.range)),
      ...(attachment.id !== undefined && attachment.id !== '' ? { id: attachment.id } : {}),
      ...(attachment.side ? { side: attachment.side } : {}),
    }));
  }
  async checkAttachment(attachment: GlyphContextAttachment): Promise<string | undefined> {
    if (attachment.kind === GlyphContextAttachmentKind.SKILL || attachment.kind === GlyphContextAttachmentKind.RULE) {
      const source = this.referenceSource(attachment.uri);
      if (!source || source.status !== 'active' || source.enabled === false)
        return 'Selected instruction is unavailable. Remove it or choose it again.';
      return source.revision && source.revision !== attachment.contentRevision
        ? 'These instructions changed. The latest version will load when you send.'
        : undefined;
    }

    if (attachment.unavailable !== undefined && attachment.unavailable !== '') return attachment.unavailable;
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

  rebindAttachment(attachment: GlyphContextAttachment): GlyphContextAttachment {
    const { unavailable: _unavailable, token: _token, ...capture } = attachment;
    const uri = URI.parse(attachment.uri);
    if (
      uri.scheme === 'untitled' ||
      capture.kind === GlyphContextAttachmentKind.SKILL ||
      capture.kind === GlyphContextAttachmentKind.RULE
    )
      return capture;
    if (uri.scheme !== 'file')
      return { ...capture, unavailable: 'Workspace changed. Capture this context again before sending.' };
    if (!this.workspace.isInsideWorkspace(uri))
      return {
        ...capture,
        unavailable: 'Source folder was removed. Remove this attachment or add its folder again before sending.',
      };
    return { ...capture, path: this.adapter.contextPath(uri) };
  }
  async openAttachment(attachment: Pick<GlyphAttachmentPreview, 'path' | 'uri' | 'range'>): Promise<void> {
    if (attachment.uri?.startsWith('glyph-skill:')) return this.openSkill(attachment.uri);
    if (attachment.uri?.startsWith('glyph-rule:')) {
      const source = this.referenceSource(attachment.uri);
      if (!source) throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'Selected instruction is unavailable.');
      if (source.uri) await this.editors.openEditor({ resource: URI.parse(source.uri), options: { pinned: true } });
      else await this.openAttachment({ path: source.path });
      return;
    }

    if (
      attachment.uri !== undefined &&
      attachment.uri !== '' &&
      (await this.ide.openSource(URI.parse(attachment.uri), this.editors, attachment.range))
    )
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
    if (
      (attachment.uri === undefined || attachment.uri === '') &&
      (!folder || /^(?:[a-z]+:|[/\\])|(?:^|[/\\])\.\.(?:[/\\]|$)/iu.test(relative))
    )
      throw new GlyphContextError(
        GlyphDesktopErrorCode.NOT_FOUND,
        'The attachment source is unavailable in this workspace.',
      );
    const uri =
      attachment.uri !== undefined && attachment.uri !== ''
        ? URI.parse(attachment.uri)
        : URI.joinPath(folder!.uri, relative);
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
  private async openSkill(reference: string): Promise<void> {
    this.assertTrusted();
    await this.refreshSkillSources?.();
    this.assertTrusted();
    const source = this.referenceSource(reference);
    if (!source?.uri) throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This skill is unavailable.');
    const selectedUri = source.uri;
    const resource = URI.parse(selectedUri);
    if (resource.scheme !== 'file')
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This skill is unavailable.');
    // The host authorized the indexed manifest. Recheck its file and directory chain at editor-open time.
    const depthToRoot = source.path.split('/').length;
    let current = resource;
    for (let depth = 0; depth <= depthToRoot; depth++) {
      const stat = await this.files.stat(current);
      if (stat.isSymbolicLink || (depth === 0 ? !stat.isFile : !stat.isDirectory))
        throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This skill is unavailable.');
      current = dirname(current);
    }
    this.assertTrusted();
    if (this.referenceSource(reference)?.uri !== selectedUri)
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This skill is unavailable.');
    await this.editors.openEditor({ resource, options: { pinned: true } });
  }

  private referenceSource(value: string): GlyphSkill | GlyphInstructionSource | undefined {
    const uri = URI.parse(value);
    const id = decodeURIComponent(value.slice(value.indexOf(':') + 1));
    return uri.scheme === 'glyph-skill'
      ? this.skillSources().find(source => source.id === id)
      : uri.scheme === 'glyph-rule'
        ? this.instructionSources().find(source => source.id === id)
        : undefined;
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
