import { resolveInstructionId } from '#vs/platform/glyph/instructions/resolveInstructionId.js';
import type { GlyphSkill } from '#glyph/protocol/events/GlyphSkill.js';
import { Emitter } from '#vs/base/common/event.js';
import { RunOnceScheduler } from '#vs/base/common/async.js';
import { DisposableStore, DisposableMap, MutableDisposable, type IDisposable } from '#vs/base/common/lifecycle.js';
import { GlyphIdeContext } from './GlyphIdeContext.js';
import { IInstantiationService } from '#vs/platform/instantiation/common/instantiation.js';
import { basename, dirname, ExtUri } from '#vs/base/common/resources.js';
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
import { FileSystemProviderCapabilities, IFileService } from '#vs/platform/files/common/files.js';
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
  private skillSources: () => readonly GlyphSkill[] = () => [];
  private readonly instructionsChanged = this._register(new Emitter<void>());
  private readonly resourceIdentity = new ExtUri(
    uri => !this.files.hasCapability(uri, FileSystemProviderCapabilities.PathCaseSensitive),
  );
  private readonly instructionWatchers = this._register(new DisposableStore());
  private readonly rootWatches = this._register(new DisposableMap<string>());
  private instructionRoots: () => readonly string[] = () => [];
  private watchInstructionModel: ((model: ITextModel) => void) | undefined;
  private instructionFingerprint = '';
  private refreshInstructionSources: ((invalidate?: boolean) => Promise<void>) | undefined;
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
  setSkillSources(source: () => readonly GlyphSkill[], refresh?: () => Promise<void>): void {
    this.skillSources = source;
    if (refresh) this.setInstructionRefresh(refresh);
  }
  setInstructionRefresh(refresh?: (invalidate?: boolean) => Promise<void>, roots?: () => readonly string[]): void {
    this.instructionRoots = roots ?? (() => []);
    this.rootWatches.clearAndDisposeAll();
    this.refreshInstructionSources = refresh;
    this.instructionWatchers.clear();
    this.watchInstructionModel = undefined;
    if (!refresh) return;
    const followup = this.instructionWatchers.add(
      new RunOnceScheduler(() => {
        if (this.trust.isWorkspaceTrusted()) void refresh(true).catch(() => {});
      }, 1000),
    );
    const changed = this.instructionWatchers.add(
      new RunOnceScheduler(() => {
        if (!this.trust.isWorkspaceTrusted()) return;
        void refresh(true).catch(() => {});
        followup.schedule();
      }, 300),
    );
    const relevant = (uri: URI) =>
      /\/\.(?:glyph|cursor)(?:\/(?:rules|skills)(?:\/|$)|$)/iu.test(uri.path) ||
      /\/AGENTS\.md$/iu.test(uri.path) ||
      this.instructionSources().some(instruction => {
        if (instruction.uri === uri.toString()) return true;
        if (!instruction.references?.length) return false;
        if (instruction.kind === 'glyph_user_rule') return false;
        try {
          const path = this.adapter.contextPath(uri);
          if (instruction.references.includes(path)) return true;
          if (!this.resourceIdentity.ignorePathCasing(uri)) return false;
          const routed = this.workspace.getWorkspace().folders.length > 1;
          const root = path.split('/')[0];
          return instruction.references.some(
            reference =>
              (!routed || reference.split('/')[0] === root) && reference.toLowerCase() === path.toLowerCase(),
          );
        } catch {
          return false;
        }
      }) ||
      [...this.rootWatches.keys()].some(root => this.resourceIdentity.isEqualOrParent(uri, URI.parse(root)));
    const providerChanges = this.instructionWatchers.add(new MutableDisposable<IDisposable>());
    const observeProvider = () => {
      providerChanges.value = this.files.getProvider('file')?.onDidChangeFile(changes => {
        if (changes.some(change => relevant(change.resource))) changed.schedule();
      });
    };
    observeProvider();
    this.instructionWatchers.add(
      this.files.onDidChangeFileSystemProviderRegistrations(event => {
        if (event.scheme === 'file') observeProvider();
      }),
    );
    const watched = new WeakSet<ITextModel>();
    const watch = (model: ITextModel) => {
      if (!watched.has(model) && relevant(model.uri)) {
        watched.add(model);
        this.instructionWatchers.add(
          model.onDidChangeContent(() => {
            changed.schedule();
          }),
        );
      }
    };
    this.watchInstructionModel = watch;
    for (const model of this.models.getModels()) watch(model);
    this.instructionWatchers.add(this.models.onModelAdded(watch));
  }
  onDidChangeInstructions(listener: () => void): () => void {
    const subscription = this.instructionsChanged.event(listener);
    return () => {
      subscription.dispose();
    };
  }
  notifyInstructionsChanged(): void {
    const roots = new Map<string, boolean>();
    if (this.trust.isWorkspaceTrusted()) {
      for (const root of this.instructionRoots()) roots.set(root, basename(URI.parse(root)) !== 'skill-state.json');
      for (const source of this.instructionSources()) {
        if (source.kind !== 'glyph_user_rule' || !source.uri || !source.references?.length) continue;
        // The authorized user store owns paths relative to its .glyph directory.
        const uri = source.uri;
        const rulesRoot = this.instructionRoots().find(root => uri.startsWith(`${root}/`));
        if (!rulesRoot) continue;
        for (const path of source.references)
          roots.set(URI.joinPath(dirname(URI.parse(rulesRoot)), path).toString(), false);
      }
    }
    for (const root of this.rootWatches.keys()) if (!roots.has(root)) this.rootWatches.deleteAndDispose(root);
    for (const [root, recursive] of roots)
      if (!this.rootWatches.has(root))
        this.rootWatches.set(root, this.files.watch(URI.parse(root), { recursive, excludes: [] }));
    for (const model of this.models.getModels()) this.watchInstructionModel?.(model);
    const fingerprint = JSON.stringify([this.instructionSources(), this.skillSources()]);
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
    await this.refreshInstructionSources?.();
    this.assertTrusted();
    const normalized = query.toLowerCase();
    const rules = this.instructionSources()
      .filter(rule => isManualRule(rule))
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
          detail: rule.description ? `${rule.description} · ${rule.path}` : rule.path,
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
    const path = this.adapter.contextPath(uri) || '.';
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
    if (!currentWorkspaceFolder || (this.adapter.contextPath(uri) || '.') !== path)
      throw new GlyphContextError(GlyphDesktopErrorCode.STALE_DOCUMENT, 'The workspace changed during capture.');
    return { id: generateUuid(), kind: GlyphContextAttachmentKind.FOLDER, uri: value, path, text, contentRevision };
  }
  async refreshAttachment(attachment: GlyphContextAttachment): Promise<GlyphContextAttachment> {
    if (attachment.kind === GlyphContextAttachmentKind.RULE) {
      this.assertTrusted();
      await this.refreshInstructionSources?.();
      this.assertTrusted();
      const rule = resolveInstructionId(
        this.instructionSources(),
        attachment.ruleId ?? decodeURIComponent(attachment.uri.slice('glyph-rule:'.length)),
      );
      if (!rule || !isManualRule(rule))
        throw new GlyphContextError(
          GlyphDesktopErrorCode.NOT_FOUND,
          'Selected manual rule is unavailable. Choose it again.',
        );
      const { unavailable: _, ...reference } = attachment;
      return { ...reference, path: rule.name ?? attachment.path, contentRevision: rule.revision ?? rule.id };
    }
    if (attachment.kind === GlyphContextAttachmentKind.SKILL) {
      this.assertTrusted();
      const source = this.skillSource(attachment.uri);
      if (!source || source.status !== 'active' || !source.enabled)
        throw new GlyphContextError(
          GlyphDesktopErrorCode.NOT_FOUND,
          'Selected instruction is unavailable. Choose it again.',
        );
      const { unavailable: _, ...reference } = attachment;
      return { ...reference, path: source.name, contentRevision: source.revision ?? source.id };
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
    if (attachment.kind === GlyphContextAttachmentKind.SKILL) {
      const source = this.skillSource(attachment.uri);
      if (!source || source.status !== 'active' || !source.enabled)
        return 'Selected instruction is unavailable. Remove it or choose it again.';
      return source.revision && source.revision !== attachment.contentRevision
        ? 'These instructions changed. The latest version will load when you send.'
        : undefined;
    }

    if (attachment.unavailable !== undefined && attachment.unavailable !== '') return attachment.unavailable;
    if (attachment.kind === GlyphContextAttachmentKind.RULE) {
      const rule = resolveInstructionId(
        this.instructionSources(),
        attachment.ruleId ?? decodeURIComponent(attachment.uri.slice('glyph-rule:'.length)),
      );
      if (!rule || !isManualRule(rule)) return 'Selected manual rule is unavailable. Remove it or choose it again.';
      return rule.revision && rule.revision !== attachment.contentRevision
        ? 'These instructions changed. The latest version will load when you send.'
        : undefined;
    }
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
    return { ...capture, path: this.adapter.contextPath(uri) || '.' };
  }
  async openAttachment(attachment: Pick<GlyphAttachmentPreview, 'path' | 'uri' | 'range'>): Promise<void> {
    if (attachment.uri?.startsWith('glyph-skill:')) return this.openSkill(attachment.uri);
    if (attachment.uri?.startsWith('glyph-rule:'))
      return this.openInstruction(decodeURIComponent(attachment.uri.slice('glyph-rule:'.length)));
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
  async openInstruction(id: string): Promise<void> {
    this.assertTrusted();
    await this.refreshInstructionSources?.(true);
    this.assertTrusted();
    const source = resolveInstructionId(this.instructionSources(), id);
    if (!source || (source.status === 'error' && !source.revision && !source.managementRevision))
      throw unavailableInstruction();

    let root: URI;
    let resource: URI;
    let stillOwned: () => boolean;
    if (source.kind === 'glyph_user_rule') {
      if (!source.uri) throw unavailableInstruction();
      resource = URI.parse(source.uri);
      const rules = dirname(resource);
      stillOwned = () => this.instructionRoots().includes(rules.toString());
      if (resource.scheme !== 'file' || !stillOwned()) throw unavailableInstruction();
      root = dirname(rules);
    } else {
      const segments = source.path.split('/');
      root = this.projectSourceRoot(segments);
      stillOwned = () =>
        this.workspace.getWorkspace().folders.some(candidate => candidate.uri.toString() === root.toString());
      resource = URI.joinPath(root, ...segments);
    }
    let current = resource;
    for (;;) {
      const stat = await this.files.stat(current);
      const projectAnchor = current.toString() === root.toString() && source.kind !== 'glyph_user_rule';
      if (
        (stat.isSymbolicLink && !(projectAnchor && source.uri)) ||
        (projectAnchor && source.uri && !(await this.matchesPhysicalSource(resource, source.uri))) ||
        (current === resource ? !stat.isFile : !stat.isDirectory)
      )
        throw unavailableInstruction();
      if (current.toString() === root.toString()) break;
      current = dirname(current);
    }
    this.assertTrusted();
    if (!stillOwned() || resolveInstructionId(this.instructionSources(), id) !== source) throw unavailableInstruction();
    await this.editors.openEditor({ resource, options: { pinned: true } });
  }

  private async matchesPhysicalSource(resource: URI, expected: string) {
    return this.resourceIdentity.isEqual(await this.files.realpath(resource), URI.parse(expected));
  }

  private projectSourceRoot(segments: string[]): URI {
    const folders = this.workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === 'file');
    const roots = folders.map(folder => ({ name: folder.name, uri: folder.uri.toString() }));
    const rootId = folders.length === 1 ? undefined : segments.shift();
    const folder =
      folders.length === 1
        ? folders[0]
        : folders.find((_folder, index) => getGlyphWorkspaceRootId(roots[index], roots) === rootId);
    if (
      !folder ||
      segments.length === 0 ||
      segments.some(part => !part || part === '..' || part === '.' || part.includes('\\'))
    )
      throw unavailableInstruction();
    return folder.uri;
  }

  private async openSkill(reference: string): Promise<void> {
    this.assertTrusted();
    await this.refreshInstructionSources?.();
    this.assertTrusted();
    const source = this.skillSource(reference);
    if (!source?.uri) throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This skill is unavailable.');
    const selectedUri = source.uri;
    const physical = URI.parse(selectedUri);
    if (physical.scheme !== 'file')
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This skill is unavailable.');
    // The host authorized the indexed manifest. Recheck its file and directory chain at editor-open time.
    const depthToRoot = source.path.split('/').length;
    const project = source.origin.scope === 'project';
    const segments = source.path.split('/');
    if (project && this.workspace.getWorkspace().folders.filter(folder => folder.uri.scheme === 'file').length > 1)
      segments.unshift(source.scope.split('/')[0]);
    const root = project ? this.projectSourceRoot(segments) : undefined;
    const resource = root ? URI.joinPath(root, ...segments) : physical;
    let current = resource;
    for (let depth = 0; depth <= depthToRoot; depth++) {
      const stat = await this.files.stat(current);
      const anchor = root && depth === depthToRoot;
      if (
        (stat.isSymbolicLink && !anchor) ||
        (anchor && !(await this.matchesPhysicalSource(resource, selectedUri))) ||
        (depth === 0 ? !stat.isFile : !stat.isDirectory)
      )
        throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This skill is unavailable.');
      current = dirname(current);
    }
    this.assertTrusted();
    if (
      (root && !this.workspace.getWorkspace().folders.some(folder => folder.uri.toString() === root.toString())) ||
      this.skillSource(reference)?.uri !== selectedUri
    )
      throw new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This skill is unavailable.');
    await this.editors.openEditor({ resource, options: { pinned: true } });
  }

  private skillSource(value: string): GlyphSkill | undefined {
    if (!value.startsWith('glyph-skill:')) return undefined;
    const id = decodeURIComponent(value.slice('glyph-skill:'.length));
    return this.skillSources().find(source => source.id === id);
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

function isManualRule(rule: GlyphInstructionSource): boolean {
  return rule.activation === 'manual' && rule.status === 'active' && rule.enabled !== false;
}

function unavailableInstruction(): GlyphContextError {
  return new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This instruction source is unavailable.');
}
