import { ScrollType } from '#vs/editor/common/editorCommon.js';
import { GlyphMarginLane } from '#vs/editor/common/model.js';
import type { GlyphAnnotationPosition, GlyphComposerState } from '#glyph/workbench/GlyphComposerState.js';
import type { GlyphAnnotation } from '#glyph/protocol/events/GlyphAnnotation.js';
import { GlyphProposalReviewError } from './GlyphProposalReviewError.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import { Disposable, DisposableStore, toDisposable } from '#vs/base/common/lifecycle.js';
import { GlyphReviewCommand } from '#glyph/workbench/GlyphReviewCommand.js';
import { IKeybindingService } from '#vs/platform/keybinding/common/keybinding.js';
import { IContextKeyService } from '#vs/platform/contextkey/common/contextkey.js';
import { addDisposableListener } from '#vs/base/browser/dom.js';
import { URI } from '#vs/base/common/uri.js';
import { IModelService } from '#vs/editor/common/services/model.js';
import { ILanguageService } from '#vs/editor/common/languages/language.js';
import { ITextModelService } from '#vs/editor/common/services/resolverService.js';
import { IEditorService } from '#vs/workbench/services/editor/common/editorService.js';
import {
  isDiffEditor,
  ContentWidgetPositionPreference,
  OverlayWidgetPositionPreference,
  type ICodeEditor,
  type IViewZone,
  type IContentWidget,
  type IGlyphMarginWidget,
  type IOverlayWidget,
} from '#vs/editor/browser/editorBrowser.js';
import type { GlyphProposalFilePreview } from '#glyph/protocol/events/GlyphProposalFilePreview.js';
import { GlyphProposalApplicability } from '#glyph/protocol/events/GlyphProposalFileSummary.js';
import type { GlyphWorkbenchState } from '#glyph/workbench/GlyphWorkbenchState.js';
import type { GlyphReviewControls } from '#glyph/workbench/GlyphReviewControls.js';
import {
  mountGlyphReview,
  mountGlyphCommentButton,
  mountGlyphEditorAnnotationMarker,
} from './ui/mountGlyphWorkbench.js';

interface ReviewActions {
  composer(): GlyphComposerState;
  report(error: unknown): void;
  state(): GlyphWorkbenchState;
  annotate(chatId: string, annotation: GlyphAnnotation): Promise<void>;
  read(chatId: string, proposalId: string, fileId: string): Promise<void>;
  decide(
    chatId: string,
    items: readonly { proposalId: string; itemId: string }[],
    accept: boolean,
    comment?: string,
  ): Promise<void>;
}

/** Read-only native diff models; decisions always go through the host's guarded editor apply. */
export class GlyphProposalEditor extends Disposable {
  private readonly annotationEditor = this._register(new DisposableStore());
  private readonly annotationWidgets = this._register(new DisposableStore());
  private readonly widgets = this._register(new DisposableStore());
  private current: { chatId: string; proposalId: string; fileId: string } | undefined;
  private preview: GlyphProposalFilePreview | undefined;
  private editor: ICodeEditor | undefined;
  private index = 0;
  private readonly commandHandlers = new Map<boolean, (command: GlyphReviewCommand) => void>();
  private openRevision = 0;
  private readonly models = new Set<string>();
  private selectionButton: { dispose(): void } | undefined;
  private controls: { update(value: GlyphReviewControls): void }[] = [];
  private hunk: { zone: IViewZone; id: string; widget: IContentWidget } | undefined;
  constructor(
    private readonly actions: ReviewActions,
    @IModelService private readonly modelService: IModelService,
    @ILanguageService private readonly languageService: ILanguageService,
    @ITextModelService resolver: ITextModelService,
    @IEditorService private readonly editors: IEditorService,
    @IKeybindingService private readonly keybindings: IKeybindingService,
  ) {
    super();
    this._register(this.keybindings.onDidUpdateKeybindings(() => this.refreshControls()));
    this._register(
      resolver.registerTextModelContentProvider('glyph-proposal', {
        provideTextContent: async uri => this.modelService.getModel(uri),
      }),
    );
    this._register(
      toDisposable(() => {
        for (const uri of this.models) this.modelService.getModel(URI.parse(uri))?.dispose();
      }),
    );
  }
  executeCommand(command: GlyphReviewCommand): void {
    if (command === GlyphReviewCommand.ADD_TO_CHAT) {
      const selection = this.editor?.getSelection();
      if (selection && !selection.isEmpty()) void this.annotate().catch(error => this.actions.report(error));
      return;
    }
    const full = ![GlyphReviewCommand.KEEP, GlyphReviewCommand.UNDO, GlyphReviewCommand.COMMENT].includes(command);
    this.commandHandlers.get(full)?.(command);
  }
  async open(chatId: string, proposalId: string, fileId: string): Promise<void> {
    const revision = ++this.openRevision;
    this.annotationEditor.clear();
    this.annotationWidgets.clear();
    this.widgets.clear();
    this.controls = [];
    this.current = { chatId, proposalId, fileId };
    this.preview = undefined;
    this.index = 0;
    await this.actions.read(chatId, proposalId, fileId);
    if (revision !== this.openRevision) return;
    const preview = this.preview as GlyphProposalFilePreview | undefined;
    if (!preview)
      throw new GlyphProposalReviewError(
        GlyphDesktopErrorCode.NOT_FOUND,
        'The proposal preview is no longer available.',
      );
    const file = this.file();
    if (!file)
      throw new GlyphProposalReviewError(GlyphDesktopErrorCode.NOT_FOUND, 'The proposal file is no longer available.');
    const original = this.uri('before');
    const modified = this.uri('after');
    const pane = await this.editors.openEditor({
      original: { resource: original },
      modified: { resource: modified },
      label: `${file.path} — Proposed changes`,
      options: { pinned: true, revealIfOpened: true },
    });
    if (revision !== this.openRevision || !pane) return;
    const diff = pane.getControl();
    if (!isDiffEditor(diff))
      throw new GlyphProposalReviewError(
        GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        'The native diff editor is unavailable.',
      );
    diff.updateOptions({ readOnly: true, originalEditable: false, renderSideBySide: false });
    this.editor = diff.getModifiedEditor();
    this.editor.updateOptions({ glyphMargin: true });
    this.installControls();
    this.widgets.add(
      this.editor.onDidChangeCursorSelection(() => {
        this.selectionButton?.dispose();
        this.selectionButton = undefined;
        const selection = this.editor?.getSelection();
        const snapshot = this.actions.composer().snapshot;
        if (
          !selection ||
          selection.isEmpty() ||
          snapshot.annotationDraft ||
          snapshot.editingAnnotation ||
          snapshot.submitting
        )
          return;
        const node = document.createElement('div');
        const mounted = mountGlyphCommentButton(
          node,
          () => this.executeCommand(GlyphReviewCommand.ADD_TO_CHAT),
          undefined,
          this.keybindings.lookupKeybinding(GlyphReviewCommand.ADD_TO_CHAT)?.getLabel() ?? undefined,
        );
        const widget: IContentWidget = {
          getId: () => 'glyph.annotation.selection',
          getDomNode: () => node,
          getPosition: () => ({
            position: selection.getEndPosition(),
            preference: [ContentWidgetPositionPreference.BELOW],
          }),
        };
        this.editor!.addContentWidget(widget);
        this.selectionButton = toDisposable(() => {
          this.editor?.removeContentWidget(widget);
          mounted.dispose();
        });
      }),
    );
    this.widgets.add(
      toDisposable(() => {
        this.selectionButton?.dispose();
        this.selectionButton = undefined;
      }),
    );
    const composer = this.actions.composer();
    this.widgets.add(toDisposable(composer.subscribe(() => this.updateAnnotationMarkers())));
    this.updateAnnotationMarkers();
    this.reveal();
  }
  acceptPreview(preview: GlyphProposalFilePreview): void {
    if (preview.proposalId !== this.current?.proposalId || preview.fileId !== this.current.fileId) return;
    this.preview = preview;
    for (const [side, value] of [
      ['before', preview.before],
      ['after', preview.after],
    ] as const) {
      const uri = this.uri(side);
      const model = this.modelService.getModel(uri);
      if (model) {
        if (model.getValue() !== value) model.setValue(value);
      } else {
        this.modelService.createModel(
          value,
          this.languageService.createByFilepathOrFirstLine(URI.file(this.file()?.path ?? '')),
          uri,
        );
        this.models.add(uri.toString());
      }
    }
    this.index = Math.min(this.index, Math.max(0, preview.items.length - 1));
    this.refreshControls();
  }
  changed(): void {
    this.refreshControls();
  }
  async refresh(): Promise<void> {
    const current = this.current;
    if (current && this.file()?.pendingItemIds.length)
      await this.actions.read(current.chatId, current.proposalId, current.fileId);
    else this.refreshControls();
  }
  async revealAnnotation(annotation: GlyphAnnotation): Promise<GlyphAnnotationPosition | undefined> {
    const [proposalId, fileId] = annotation.sourceId.split(':');
    const proposal = this.actions.state().proposals.find(value => value.id === proposalId);
    if (!proposal?.chatId || !fileId || !proposalId) return;
    if (
      this.current?.proposalId !== proposalId ||
      this.current.fileId !== fileId ||
      !this.editor?.getDomNode()?.isConnected
    )
      await this.open(proposal.chatId, proposalId, fileId);
    const editor = this.editor;
    const model = editor?.getModel();
    if (
      !editor ||
      !model ||
      annotation.revision !== `${model.id}:${model.getVersionId()}` ||
      model.getValue().slice(annotation.from, annotation.to) !== annotation.quote
    )
      return;
    const start = model.getPositionAt(annotation.from),
      end = model.getPositionAt(annotation.to);
    editor.setSelection({
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
    editor.revealPositionInCenterIfOutsideViewport(start, ScrollType.Immediate);
    const container = this.installAnnotationEditor(editor, start.lineNumber);
    const point = editor.getScrolledVisiblePosition(start);
    const bounds = editor.getDomNode()?.getBoundingClientRect();
    if (point && bounds)
      return {
        container,
        x: bounds.left + point.left,
        y: bounds.top + point.top + point.height,
        minX: bounds.left + editor.getLayoutInfo().contentLeft,
        maxX: bounds.right,
      };
    return undefined;
  }
  private updateAnnotationMarkers(): void {
    this.annotationWidgets.clear();
    const editor = this.editor,
      model = editor?.getModel(),
      current = this.current;
    if (!editor || !model || !current) return;
    const composer = this.actions.composer();
    if (!composer.snapshot.annotationDraft && !composer.snapshot.editingAnnotation) this.annotationEditor.clear();
    if (composer.snapshot.annotationDraft || composer.snapshot.editingAnnotation) {
      this.selectionButton?.dispose();
      this.selectionButton = undefined;
    }
    if (composer.snapshot.submitting) {
      this.selectionButton?.dispose();
      this.selectionButton = undefined;
      const position = editor.getPosition();
      if (position) editor.setPosition(position);
      return;
    }
    let hasMarkers = false;
    for (const annotation of composer.snapshot.document.options?.annotations ?? []) {
      if (
        annotation.kind !== 'proposal' ||
        annotation.revision !== `${model.id}:${model.getVersionId()}` ||
        !annotation.sourceId.startsWith(`${current.proposalId}:${current.fileId}:`) ||
        model.getValue().slice(annotation.from, annotation.to) !== annotation.quote
      )
        continue;
      const node = document.createElement('div');
      const mount = mountGlyphEditorAnnotationMarker(node, annotation.order, annotation.comment, () =>
        composer.editAnnotation(annotation.id),
      );
      const anchor = model.getPositionAt(annotation.from);
      const widget: IGlyphMarginWidget = {
        getId: () => `glyph.annotation.${annotation.id}`,
        getDomNode: () => node,
        getPosition: () => ({
          lane: GlyphMarginLane.Right,
          zIndex: 10 + annotation.order,
          range: { startLineNumber: anchor.lineNumber, endLineNumber: anchor.lineNumber, startColumn: 1, endColumn: 1 },
        }),
      };
      editor.addGlyphMarginWidget(widget);
      hasMarkers = true;
      this.annotationWidgets.add(
        toDisposable(() => {
          editor.removeGlyphMarginWidget(widget);
          mount.dispose();
        }),
      );
    }
    // Monaco treats the gutter as decorative. Our buttons are interactive, so
    // expose it while annotations exist and restore its original state on cleanup.
    const margin = editor.getDomNode()?.querySelector('.margin');
    if (hasMarkers && margin) {
      const hidden = margin.getAttribute('aria-hidden');
      margin.removeAttribute('aria-hidden');
      this.annotationWidgets.add(
        toDisposable(() => {
          if (hidden === null) margin.removeAttribute('aria-hidden');
          else margin.setAttribute('aria-hidden', hidden);
        }),
      );
    }
  }
  private file() {
    return this.actions
      .state()
      .proposals.find(p => p.id === this.current?.proposalId)
      ?.files.find(f => f.id === this.current?.fileId);
  }
  private files() {
    return this.actions
      .state()
      .proposals.filter(p => p.chatId === this.current?.chatId)
      .flatMap(p => p.files.filter(f => f.pendingItemIds.length).map(f => ({ proposalId: p.id, file: f })));
  }
  private uri(side: string): URI {
    return URI.from({
      scheme: 'glyph-proposal',
      path: `/${this.current!.proposalId}/${this.current!.fileId}/${side}/${this.file()?.path.split('/').at(-1) ?? 'file'}`,
    });
  }
  private move(amount: number): void {
    const count = this.preview?.items.length ?? 0;
    this.index = count ? (this.index + amount + count) % count : 0;
    this.refreshControls();
    this.reveal();
  }
  private reveal(): void {
    const line = this.preview?.items[this.index]?.lineNumber ?? 1;
    this.editor?.revealLineInCenter(line);
    if (this.hunk && this.editor) {
      this.hunk.zone.afterLineNumber = line;
      this.editor.changeViewZones(accessor => accessor.layoutZone(this.hunk!.id));
      this.editor.layoutContentWidget(this.hunk.widget);
    }
  }

  private async decide(scope: 'item' | 'file' | 'all', accept: boolean): Promise<void> {
    const current = this.current;
    if (!current) return;
    const item = this.preview?.items[this.index];
    const files =
      scope === 'all'
        ? this.files()
        : this.files().filter(f => f.proposalId === current.proposalId && f.file.id === current.fileId);
    const items = files.flatMap(({ proposalId, file }) =>
      file.pendingItemIds.filter(id => scope !== 'item' || id === item?.id).map(itemId => ({ proposalId, itemId })),
    );
    await this.actions.decide(current.chatId, items, accept);
    await this.refresh();
    this.reveal();
  }

  private installAnnotationEditor(editor: ICodeEditor, lineNumber: number): HTMLElement {
    this.annotationEditor.clear();
    const node = document.createElement('div');
    node.style.boxSizing = 'border-box';
    node.style.padding = '8px';
    node.style.position = 'absolute';
    const zone: IViewZone = {
      afterLineNumber: lineNumber - 1,
      heightInPx: 128,
      domNode: document.createElement('div'),
      showInHiddenAreas: true,
      onDomNodeTop: top => {
        node.style.top = `${top}px`;
      },
    };
    let id = '';
    editor.changeViewZones(accessor => {
      id = accessor.addZone(zone);
    });
    const widget: IOverlayWidget = {
      getId: () => 'glyph.annotation.editor',
      getDomNode: () => node,
      getPosition: () => null,
    };
    const layout = () => {
      node.style.width = `${Math.max(0, editor.getLayoutInfo().contentWidth - 16)}px`;
      node.style.left = `${editor.getLayoutInfo().contentLeft}px`;
      editor.layoutOverlayWidget(widget);
    };
    editor.addOverlayWidget(widget);
    layout();
    this.annotationEditor.add(editor.onDidLayoutChange(layout));
    const observer = new ResizeObserver(() => {
      const height = Math.max(128, Math.ceil(node.getBoundingClientRect().height));
      if (zone.heightInPx !== height) {
        zone.heightInPx = height;
        editor.changeViewZones(accessor => accessor.layoutZone(id));
      }
      node.style.left = `${editor.getLayoutInfo().contentLeft}px`;
      editor.layoutOverlayWidget(widget);
    });
    observer.observe(node);
    this.annotationEditor.add(
      toDisposable(() => {
        observer.disconnect();
        editor.removeOverlayWidget(widget);
        editor.changeViewZones(accessor => accessor.removeZone(id));
      }),
    );
    return node;
  }

  private captureAnnotation(comment = ''): GlyphAnnotation | undefined {
    const current = this.current;
    const model = this.editor?.getModel();
    const selected = this.editor?.getSelection();
    if (!current || !model || this.actions.state().readOnly) return;
    const item = this.preview?.items[this.index];
    const range = selected && !selected.isEmpty() ? selected : model.getFullModelRange();
    const quote = model.getValueInRange(range);
    if (!quote) return;
    if (quote.length > 50000)
      throw new GlyphProposalReviewError(
        GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
        'Select a passage shorter than 50,000 characters to annotate.',
      );
    return {
      id: crypto.randomUUID(),
      order: 1,
      kind: 'proposal',
      sourceId: `${current.proposalId}:${current.fileId}:${item?.id ?? ''}`,
      revision: `${model.id}:${model.getVersionId()}`,
      label: this.file()?.path ?? 'Proposal',
      quote,
      from: model.getOffsetAt(range.getStartPosition()),
      to: model.getOffsetAt(range.getEndPosition()),
      comment,
    };
  }

  private async annotate(comment = ''): Promise<void> {
    const annotation = this.captureAnnotation(comment);
    if (annotation && this.current) await this.actions.annotate(this.current.chatId, annotation);
  }
  private properties(full: boolean): GlyphReviewControls {
    const state = this.actions.state();
    const file = this.file();
    const files = this.files();
    const index = files.findIndex(f => f.proposalId === this.current?.proposalId && f.file.id === this.current?.fileId);
    const disabled = state.readOnly || !file?.pendingItemIds.length;
    const navigateFile = async (amount: number) => {
      const target =
        files[index < 0 ? (amount > 0 ? 0 : files.length - 1) : (index + amount + files.length) % files.length];
      if (target && this.current) await this.open(this.current.chatId, target.proposalId, target.file.id);
    };
    const current = this.current;
    const item = this.preview?.items[this.index];
    return {
      itemId: item?.id,
      fileComplete: !!file && file.pendingItemIds.length === 0,
      shortcuts: Object.fromEntries(
        Object.values(GlyphReviewCommand).flatMap(command => {
          const label = this.keybindings.lookupKeybinding(command)?.getLabel();
          return label ? [[command, label]] : [];
        }),
      ),
      registerCommands: handler => {
        this.commandHandlers.set(full, handler);
        return () => {
          if (this.commandHandlers.get(full) === handler) this.commandHandlers.delete(full);
        };
      },
      ...(!full && current && item
        ? {
            rejectWithComment: async (comment: string) => {
              const annotation = this.captureAnnotation(comment);
              await this.actions.decide(
                current.chatId,
                [{ proposalId: current.proposalId, itemId: item.id }],
                false,
                comment,
              );
              if (annotation) await this.actions.annotate(current.chatId, annotation);
              await this.refresh();
              this.reveal();
            },
          }
        : {}),
      label: !file?.pendingItemIds.length
        ? 'Review complete'
        : `${this.index + 1} of ${this.preview?.items.length ?? 0}`,
      disabled,
      navigationDisabled: state.readOnly || files.length === 0,
      keepAllDisabled:
        state.readOnly ||
        files.length === 0 ||
        files.some(
          ({ file }) =>
            (file.textOnly !== true && !file.autoApplied) ||
            ![GlyphProposalApplicability.READY, GlyphProposalApplicability.FAILED_RETRYABLE].includes(
              file.applicability,
            ),
        ),
      keepDisabled:
        disabled ||
        (file?.textOnly !== true && !file?.autoApplied) ||
        file.applicability === GlyphProposalApplicability.STALE ||
        file.applicability === GlyphProposalApplicability.APPLYING,
      previous: () => this.move(-1),
      next: () => this.move(1),
      keep: () => this.decide('item', true),
      undo: () => this.decide('item', false),
      ...(full
        ? {
            fileLabel: `${Math.max(index + 1, 0)} of ${files.length} Files`,
            previousFile: () => navigateFile(-1),
            nextFile: () => navigateFile(1),
            keepFile: () => this.decide('file', true),
            undoFile: () => this.decide('file', false),
            keepAll: () => this.decide('all', true),
          }
        : {}),
    };
  }
  private installControls(): void {
    const editor = this.editor;
    if (!editor) return;
    const context = editor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
    const reviewContext = context.createKey<boolean>('glyph.reviewEditor', false);
    reviewContext.set(true);
    const textInputContext = context.createKey<boolean>('glyph.reviewTextInput', false);
    const editorNode = editor.getDomNode();
    if (editorNode)
      this.widgets.add(
        addDisposableListener(editorNode, 'focusin', (event: FocusEvent) => {
          const target = event.target;
          textInputContext.set(
            target instanceof Element && !!target.closest('input, textarea:not(.inputarea), [contenteditable="true"]'),
          );
        }),
      );
    this.widgets.add(
      toDisposable(() => {
        reviewContext.reset();
        textInputContext.reset();
      }),
    );
    const expectedModel = editor.getModel();
    const mounted = [true, false].map(full => {
      const node = document.createElement('div');
      const zone: IViewZone = {
        afterLineNumber: full ? 0 : (this.preview?.items[this.index]?.lineNumber ?? 1),
        heightInPx: 40,
        // View zones are aria-hidden in Code OSS. Reserve space here and mount
        // interactive controls in its accessible widget layer instead.
        domNode: document.createElement('div'),
        suppressMouseDown: false,
        showInHiddenAreas: true,
      };
      let id = '';
      editor.changeViewZones(accessor => {
        id = accessor.addZone(zone);
      });
      const overlay: IOverlayWidget = {
        getId: () => 'glyph.review.file',
        getDomNode: () => node,
        getPosition: () => ({ preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER }),
      };
      const content: IContentWidget = {
        getId: () => 'glyph.review.hunk',
        getDomNode: () => node,
        getPosition: () => ({
          position: { lineNumber: this.preview?.items[this.index]?.lineNumber ?? 1, column: 1 },
          preference: [ContentWidgetPositionPreference.BELOW],
        }),
      };
      const layout = () => {
        // Widget width is editor geometry; presentation and colors live in Emotion.
        node.style.width = `${Math.max(0, (full ? editor.getLayoutInfo().width : editor.getLayoutInfo().contentWidth) - editor.getLayoutInfo().verticalScrollbarWidth)}px`;
        if (full) editor.layoutOverlayWidget(overlay);
        else editor.layoutContentWidget(content);
      };
      node.style.width = `${Math.max(0, (full ? editor.getLayoutInfo().width : editor.getLayoutInfo().contentWidth) - editor.getLayoutInfo().verticalScrollbarWidth)}px`;
      if (full) editor.addOverlayWidget(overlay);
      else editor.addContentWidget(content);
      this.widgets.add(editor.onDidLayoutChange(layout));
      const view = mountGlyphReview(node, this.properties(full));
      const observer = new ResizeObserver(entries => {
        const height = Math.ceil(entries[0]!.borderBoxSize[0]!.blockSize);
        if (zone.heightInPx !== height) {
          zone.heightInPx = height;
          editor.changeViewZones(accessor => accessor.layoutZone(id));
        }
      });
      if (node.firstElementChild) observer.observe(node.firstElementChild);
      if (!full) this.hunk = { zone, id, widget: content };
      this.widgets.add(
        toDisposable(() => {
          observer.disconnect();
          view.dispose();
          if (full) editor.removeOverlayWidget(overlay);
          else editor.removeContentWidget(content);
          editor.changeViewZones(accessor => accessor.removeZone(id));
        }),
      );
      return view;
    });
    this.controls = mounted;
    this.widgets.add(
      editor.onDidChangeModel(() => {
        if (editor.getModel() !== expectedModel) {
          this.annotationEditor.clear();
          this.widgets.clear();
          this.controls = [];
          this.editor = undefined;
        }
      }),
    );
    this.widgets.add(
      editor.onDidDispose(() => {
        this.annotationEditor.clear();
        this.widgets.clear();
        this.controls = [];
        this.editor = undefined;
      }),
    );
  }
  private refreshControls(): void {
    this.controls[0]?.update(this.properties(true));
    this.controls[1]?.update(this.properties(false));
    if (this.hunk && this.editor && !this.file()?.pendingItemIds.length) {
      this.hunk.widget.getDomNode().style.display = 'none';
      this.hunk.zone.heightInPx = 0;
      this.editor.changeViewZones(accessor => accessor.layoutZone(this.hunk!.id));
    }
  }
}
