import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { Emitter } from '#vs/base/common/event.js';
import { URI } from '#vs/base/common/uri.js';
import { EditorType, ScrollType } from '#vs/editor/common/editorCommon.js';
import { GlyphMarginLane, type ITextModel } from '#vs/editor/common/model.js';
import { Position } from '#vs/editor/common/core/position.js';
import { Selection } from '#vs/editor/common/core/selection.js';
import type { IRange } from '#vs/editor/common/core/range.js';
import {
  ContentWidgetPositionPreference,
  OverlayWidgetPositionPreference,
  type IContentWidget,
  type IGlyphMarginWidget,
  type IOverlayWidget,
  type IViewZone,
} from '#vs/editor/browser/editorBrowser.js';
import { createTextModel } from '#vs/editor/test/common/testTextModel.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import { GlyphProposalApplicability } from '#glyph/protocol/events/GlyphProposalFileSummary.js';
import type { GlyphProposalFilePreview } from '#glyph/protocol/events/GlyphProposalFilePreview.js';
import type { GlyphAnnotation } from '#glyph/protocol/events/GlyphAnnotation.js';
import { GlyphReviewCommand } from '#glyph/workbench/GlyphReviewCommand.js';
import type { GlyphReviewControls } from '#glyph/workbench/GlyphReviewControls.js';
import type { GlyphWorkbenchState } from '#glyph/workbench/GlyphWorkbenchState.js';
import { GlyphProposalEditor } from '#vs/workbench/contrib/glyph/browser/GlyphProposalEditor.js';

const mounts = vi.hoisted(() => ({
  mountGlyphReview: vi.fn(),
  mountGlyphCommentButton: vi.fn(),
  mountGlyphEditorAnnotationMarker: vi.fn(),
}));
vi.mock('#code-oss/ui/mountGlyphWorkbench.tsx', () => mounts);

interface FakeFile {
  id: string;
  path: string;
  pendingItemIds: string[];
  textOnly?: boolean;
  autoApplied?: boolean;
  applicability: GlyphProposalApplicability;
}
interface FakeProposal {
  id: string;
  chatId?: string;
  files: FakeFile[];
}

const fileOf = (overrides: Partial<FakeFile> = {}): FakeFile => ({
  id: 'f1',
  path: 'src/a.ts',
  pendingItemIds: ['i1', 'i2'],
  textOnly: true,
  applicability: GlyphProposalApplicability.READY,
  ...overrides,
});

const stateOf = (proposals: FakeProposal[] = [{ id: 'p1', chatId: 'c1', files: [fileOf()] }], readOnly = false) =>
  ({ readOnly, proposals }) as unknown as GlyphWorkbenchState;

const previewOf = (
  proposalId = 'p1',
  fileId = 'f1',
  overrides: Partial<GlyphProposalFilePreview> = {},
): GlyphProposalFilePreview => ({
  proposalId,
  fileId,
  before: 'one\ntwo\n',
  after: 'one\nTWO\nthree\n',
  items: [
    { id: 'i1', lineNumber: 2 },
    { id: 'i2', lineNumber: 3 },
  ],
  ...overrides,
});

interface ComposerSnapshot {
  annotationDraft?: GlyphAnnotation;
  editingAnnotation?: string;
  submitting?: boolean;
  document: { options?: { annotations?: GlyphAnnotation[] } };
}

const composerOf = () => {
  const listeners = new Set<() => void>();
  const composer = {
    snapshot: { document: {} } as ComposerSnapshot,
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    editAnnotation: vi.fn(),
    publish(snapshot: ComposerSnapshot) {
      composer.snapshot = snapshot;
      for (const listener of listeners) listener();
    },
  };
  return composer;
};

const codeEditorOf = (model: ITextModel | null, options: { dom?: boolean } = {}) => {
  const selectionChanged = new Emitter<void>();
  const layoutChanged = new Emitter<void>();
  const modelChanged = new Emitter<void>();
  const disposed = new Emitter<void>();
  const dom = document.createElement('div');
  const margin = document.createElement('div');
  margin.className = 'margin';
  margin.setAttribute('aria-hidden', 'true');
  dom.append(margin);
  document.body.append(dom);
  onTestFinished(() => {
    dom.remove();
  });
  const keys = new Map<string, { value: unknown; set: Mock; reset: Mock }>();
  const zones = new Map<string, IViewZone>();
  const content = new Map<string, IContentWidget>();
  const overlay = new Map<string, IOverlayWidget>();
  const glyph = new Map<string, IGlyphMarginWidget>();
  let nextZone = 0;
  let selection: Selection | null = null;
  const editor = {
    model,
    position: null as Position | null,
    dom,
    margin,
    keys,
    zones,
    content,
    overlay,
    glyph,
    layoutInfo: { width: 800, contentWidth: 700, verticalScrollbarWidth: 14, contentLeft: 60 },
    diff: {
      getEditorType: () => EditorType.IDiffEditor,
      updateOptions: vi.fn(),
      getModifiedEditor: () => editor,
    },
    select(next: Selection | null) {
      selection = next;
      selectionChanged.fire();
    },
    layout() {
      layoutChanged.fire();
    },
    changeModel(next: ITextModel | null) {
      editor.model = next;
      modelChanged.fire();
    },
    dispose() {
      disposed.fire();
    },
    getModel: () => editor.model,
    getSelection: () => selection,
    setSelection: vi.fn((range: IRange) => {
      selection = new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
    }),
    getPosition: () => editor.position,
    setPosition: vi.fn(),
    updateOptions: vi.fn(),
    getDomNode: () => (options.dom === false ? null : dom),
    getLayoutInfo: () => editor.layoutInfo,
    invokeWithinContext: <T>(fn: (accessor: { get(id: unknown): unknown }) => T) =>
      fn({
        get: () => ({
          createKey: (key: string, value: unknown) => {
            const contextKey = {
              value,
              set: vi.fn((next: unknown) => {
                contextKey.value = next;
              }),
              reset: vi.fn(() => {
                contextKey.value = value;
              }),
            };
            keys.set(key, contextKey);
            return contextKey;
          },
        }),
      }),
    onDidChangeCursorSelection: selectionChanged.event,
    onDidLayoutChange: layoutChanged.event,
    onDidChangeModel: modelChanged.event,
    onDidDispose: disposed.event,
    addContentWidget: vi.fn((widget: IContentWidget) => {
      content.set(widget.getId(), widget);
      dom.append(widget.getDomNode());
    }),
    removeContentWidget: vi.fn((widget: IContentWidget) => {
      content.delete(widget.getId());
      widget.getDomNode().remove();
    }),
    layoutContentWidget: vi.fn(),
    addOverlayWidget: vi.fn((widget: IOverlayWidget) => {
      overlay.set(widget.getId(), widget);
      dom.append(widget.getDomNode());
    }),
    removeOverlayWidget: vi.fn((widget: IOverlayWidget) => {
      overlay.delete(widget.getId());
      widget.getDomNode().remove();
    }),
    layoutOverlayWidget: vi.fn(),
    addGlyphMarginWidget: vi.fn((widget: IGlyphMarginWidget) => glyph.set(widget.getId(), widget)),
    removeGlyphMarginWidget: vi.fn((widget: IGlyphMarginWidget) => glyph.delete(widget.getId())),
    layoutZone: vi.fn(),
    changeViewZones: vi.fn(
      (
        callback: (accessor: {
          addZone(zone: IViewZone): string;
          layoutZone(id: string): void;
          removeZone(id: string): void;
        }) => void,
      ) => {
        callback({
          addZone: zone => {
            const id = `zone-${nextZone++}`;
            zones.set(id, zone);
            return id;
          },
          layoutZone: (id: string) => {
            editor.layoutZone(id);
          },
          removeZone: id => {
            zones.delete(id);
          },
        });
      },
    ),
    revealLineInCenter: vi.fn(),
    revealPositionInCenterIfOutsideViewport: vi.fn(),
    getScrolledVisiblePosition: vi.fn((): { left: number; top: number; height: number } | null => ({
      left: 10,
      top: 20,
      height: 18,
    })),
  };
  return editor;
};
type FakeCodeEditor = ReturnType<typeof codeEditorOf>;

interface MountedReview {
  node: HTMLElement;
  controls: GlyphReviewControls;
  update: Mock;
  dispose: Mock;
}

const harnessOf = (
  setup: {
    state?: GlyphWorkbenchState;
    preview?: (proposalId: string, fileId: string) => GlyphProposalFilePreview | undefined;
    reviewContent?: boolean;
    dom?: boolean;
  } = {},
) => {
  let state = setup.state ?? stateOf();
  const models = new Map<string, ITextModel>();
  const composer = composerOf();
  const codes: FakeCodeEditor[] = [];
  const reviews: MountedReview[] = [];
  const buttons: { node: HTMLElement; open: () => void; shortcut?: string; dispose: Mock }[] = [];
  const markers: { node: HTMLElement; order: number; comment: string; open: () => void; dispose: Mock }[] = [];
  mounts.mountGlyphReview.mockImplementation((node: HTMLElement, controls: GlyphReviewControls) => {
    if (setup.reviewContent !== false) {
      const body = document.createElement('div');
      body.style.height = '40px';
      node.append(body);
    }
    const view: MountedReview = {
      node,
      controls,
      update: vi.fn((next: GlyphReviewControls) => {
        view.controls = next;
      }),
      dispose: vi.fn(),
    };
    reviews.push(view);
    return view;
  });
  mounts.mountGlyphCommentButton.mockImplementation(
    (node: HTMLElement, open: () => void, _order: undefined, shortcut?: string) => {
      const button = { node, open, shortcut, dispose: vi.fn() };
      buttons.push(button);
      return button;
    },
  );
  mounts.mountGlyphEditorAnnotationMarker.mockImplementation(
    (node: HTMLElement, order: number, comment: string, open: () => void) => {
      const marker = { node, order, comment, open, dispose: vi.fn() };
      markers.push(marker);
      return marker;
    },
  );
  const keybindingsUpdated = new Emitter<void>();
  let provider: { provideTextContent(uri: URI): Promise<unknown> } | undefined;
  const services = {
    models: {
      getModel: vi.fn((uri: URI) => models.get(uri.toString()) ?? null),
      createModel: vi.fn((value: string, _language: unknown, uri: URI) => {
        const model = createTextModel(value, null, undefined, uri);
        models.set(uri.toString(), model);
        return model;
      }),
    },
    languages: { createByFilepathOrFirstLine: vi.fn((uri: URI) => `language:${uri.path}`) },
    resolver: {
      registerTextModelContentProvider: vi.fn((_scheme: string, value: typeof provider) => {
        provider = value;
        return { dispose: vi.fn() };
      }),
    },
    editors: {
      openEditor: vi.fn(async (input: { modified: { resource: URI } }): Promise<unknown> => {
        const code = codeEditorOf(models.get(input.modified.resource.toString()) ?? null, { dom: setup.dom });
        codes.push(code);
        return { getControl: () => code.diff };
      }),
    },
    keybindings: {
      onDidUpdateKeybindings: keybindingsUpdated.event,
      lookupKeybinding: vi.fn((_command: string): { getLabel(): string | null } | undefined => undefined),
    },
  };
  const actions = {
    composer: () => composer,
    report: vi.fn(),
    state: () => state,
    annotate: vi.fn(async (_chatId: string, _annotation: GlyphAnnotation) => {}),
    read: vi.fn(async (_chatId: string, proposalId: string, fileId: string) => {
      const preview = (setup.preview ?? previewOf)(proposalId, fileId);
      if (preview) editor.acceptPreview(preview);
    }),
    decide: vi.fn(async (..._args: unknown[]) => {}),
  };
  const editor = new GlyphProposalEditor(
    actions as never,
    services.models as never,
    services.languages as never,
    services.resolver as never,
    services.editors as never,
    services.keybindings as never,
  );
  onTestFinished(() => {
    editor.dispose();
    for (const model of models.values()) if (!model.isDisposed()) model.dispose();
    mounts.mountGlyphReview.mockReset();
    mounts.mountGlyphCommentButton.mockReset();
    mounts.mountGlyphEditorAnnotationMarker.mockReset();
  });
  const view = (full: boolean) => reviews.findLast(review => 'fileLabel' in review.controls === full)!;
  return {
    editor,
    actions,
    services,
    composer,
    models,
    codes,
    reviews,
    buttons,
    markers,
    keybindingsUpdated,
    code: () => codes.at(-1)!,
    full: () => view(true).controls,
    hunk: () => view(false).controls,
    view,
    provide: (uri: URI) => provider!.provideTextContent(uri),
    setState(next: GlyphWorkbenchState) {
      state = next;
    },
    model: () => models.get(URI.from({ scheme: 'glyph-proposal', path: '/p1/f1/after/a.ts' }).toString())!,
  };
};

const annotationOf = (model: ITextModel, overrides: Partial<GlyphAnnotation> = {}): GlyphAnnotation => ({
  id: 'annotation-1',
  order: 2,
  kind: 'proposal',
  sourceId: 'p1:f1:i1',
  revision: `${model.id}:${model.getVersionId()}`,
  label: 'src/a.ts',
  quote: 'TWO',
  from: 4,
  to: 7,
  comment: 'Why?',
  ...overrides,
});

describe(GlyphProposalEditor, () => {
  it('serves proposal documents from the model service', async () => {
    const { editor, provide, model } = harnessOf();
    await editor.open('c1', 'p1', 'f1');

    expect(await provide(model().uri)).toBe(model());
    expect(await provide(URI.parse('glyph-proposal:/unknown'))).toBeNull();
  });

  it('releases the documents it created when disposed', async () => {
    const { editor, models } = harnessOf();
    await editor.open('c1', 'p1', 'f1');

    editor.dispose();

    expect([...models.values()].map(model => model.isDisposed())).toEqual([true, true]);
  });

  describe(GlyphProposalEditor.prototype.open, () => {
    it('opens the proposal as a read-only inline diff with review controls', async () => {
      const { editor, services, code, view, model } = harnessOf();

      await editor.open('c1', 'p1', 'f1');

      const [input] = services.editors.openEditor.mock.calls[0] as unknown as [
        { original: { resource: URI }; modified: { resource: URI }; label: string; options: unknown },
      ];
      expect(input.original.resource.toString()).toBe('glyph-proposal:/p1/f1/before/a.ts');
      expect(input.modified.resource.toString()).toBe('glyph-proposal:/p1/f1/after/a.ts');
      expect(input.label).toBe('src/a.ts — Proposed changes');
      expect(input.options).toEqual({ pinned: true, revealIfOpened: true });
      expect(model().getValue()).toBe('one\nTWO\nthree\n');
      expect(services.languages.createByFilepathOrFirstLine).toHaveBeenCalledWith(URI.file('src/a.ts'));
      expect(code().diff.updateOptions).toHaveBeenCalledWith({
        readOnly: true,
        originalEditable: false,
        renderSideBySide: false,
      });
      expect(code().updateOptions).toHaveBeenCalledWith({ glyphMargin: true });
      expect(code().keys.get('glyph.reviewEditor')!.value).toBe(true);
      expect(code().revealLineInCenter).toHaveBeenLastCalledWith(2);
      expect([...code().zones.values()].map(zone => [zone.afterLineNumber, zone.heightInPx])).toEqual([
        [0, 40],
        [2, 40],
      ]);
      expect(view(true).node.style.width).toBe('786px');
      expect(view(false).node.style.width).toBe('686px');
      expect(code().overlay.get('glyph.review.file')!.getPosition()).toEqual({
        preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER,
      });
      expect(code().content.get('glyph.review.hunk')!.getPosition()).toEqual({
        position: { lineNumber: 2, column: 1 },
        preference: [ContentWidgetPositionPreference.BELOW],
      });
    });

    it('reports a preview that is no longer available', async () => {
      const { editor } = harnessOf({ preview: () => undefined });

      await expect(editor.open('c1', 'p1', 'f1')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.NOT_FOUND,
        message: 'The proposal preview is no longer available.',
      });
    });

    it('reports a file that is no longer proposed', async () => {
      const { editor, services } = harnessOf({ state: stateOf([]) });

      await expect(editor.open('c1', 'p1', 'f1')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.NOT_FOUND,
        message: 'The proposal file is no longer available.',
      });
      expect(services.languages.createByFilepathOrFirstLine).toHaveBeenCalledWith(URI.file(''));
      expect(services.models.createModel.mock.calls.map(call => String(call[2]))).toEqual([
        'glyph-proposal:/p1/f1/before/file',
        'glyph-proposal:/p1/f1/after/file',
      ]);
    });

    it('stops when a newer file opens first or no editor opens', async () => {
      const { editor, actions, services, codes } = harnessOf({
        state: stateOf([{ id: 'p1', chatId: 'c1', files: [fileOf(), fileOf({ id: 'f2', path: 'src/b.ts' })] }]),
      });
      let releaseRead!: () => void;
      actions.read.mockImplementationOnce(async (_chatId, proposalId, fileId) => {
        await new Promise<void>(resolve => {
          releaseRead = resolve;
        });
        editor.acceptPreview(previewOf(proposalId, fileId));
      });

      const reading = editor.open('c1', 'p1', 'f1');
      await vi.waitFor(() => {
        expect(releaseRead).toBeDefined();
      });
      const opening = editor.open('c1', 'p1', 'f2');
      releaseRead();
      await Promise.all([reading, opening]);
      expect(services.editors.openEditor).toHaveBeenCalledTimes(1);

      let releaseEditor!: () => void;
      const open = services.editors.openEditor.getMockImplementation()!;
      services.editors.openEditor.mockImplementationOnce(async input => {
        await new Promise<void>(resolve => {
          releaseEditor = resolve;
        });
        return open(input);
      });
      const stale = editor.open('c1', 'p1', 'f1');
      await vi.waitFor(() => {
        expect(releaseEditor).toBeDefined();
      });
      services.editors.openEditor.mockResolvedValueOnce(undefined);
      const closed = editor.open('c1', 'p1', 'f2');
      releaseEditor();
      await Promise.all([stale, closed]);

      expect(codes.map(code => code.diff.updateOptions.mock.calls.length)).toEqual([1, 0]);
    });

    it('requires the native diff editor', async () => {
      const { editor, services } = harnessOf();
      services.editors.openEditor.mockResolvedValueOnce({
        getControl: () => ({ getEditorType: () => EditorType.ICodeEditor }),
      });

      await expect(editor.open('c1', 'p1', 'f1')).rejects.toMatchObject({
        code: GlyphDesktopErrorCode.UNSUPPORTED_RESOURCE,
        message: 'The native diff editor is unavailable.',
      });
    });

    it('detaches from an editor that shows another document or closes', async () => {
      for (const close of [
        (code: FakeCodeEditor) => {
          code.changeModel(null);
        },
        (code: FakeCodeEditor) => {
          code.dispose();
        },
      ]) {
        const { editor, code, view, keybindingsUpdated } = harnessOf();
        await editor.open('c1', 'p1', 'f1');
        const full = view(true);
        code().changeModel(code().model);
        expect(code().overlay.size).toBe(1);

        close(code());
        keybindingsUpdated.fire();
        const keep = full.controls.keep();
        full.controls.next();
        await keep;

        expect(code().overlay.size).toBe(0);
        expect(code().content.size).toBe(0);
        expect(code().zones.size).toBe(0);
        expect(full.dispose).toHaveBeenCalled();
        expect(full.update).not.toHaveBeenCalled();
        expect(code().keys.get('glyph.reviewEditor')!.reset).toHaveBeenCalled();
        expect(code().keys.get('glyph.reviewTextInput')!.reset).toHaveBeenCalled();
      }
    });
  });

  it('labels the current change and file', async () => {
    const { editor, services, full, hunk } = harnessOf();
    services.keybindings.lookupKeybinding.mockImplementation(command =>
      command === (GlyphReviewCommand.KEEP as string) ? { getLabel: () => '⌘Y' } : undefined,
    );

    await editor.open('c1', 'p1', 'f1');

    expect(full()).toEqual(
      expect.objectContaining({
        itemId: 'i1',
        fileComplete: false,
        shortcuts: { [GlyphReviewCommand.KEEP]: '⌘Y' },
        label: '1 of 2',
        fileLabel: '1 of 1 Files',
        disabled: false,
        navigationDisabled: false,
        keepAllDisabled: false,
        keepDisabled: false,
      }),
    );
    expect(full().rejectWithComment).toBeUndefined();
    expect(hunk().rejectWithComment).toEqual(expect.any(Function));
    expect(hunk().keepFile).toBeUndefined();
  });

  it('moves between changes, wrapping around', async () => {
    const { editor, full, code } = harnessOf();
    await editor.open('c1', 'p1', 'f1');

    full().next();
    expect(full().label).toBe('2 of 2');
    expect(code().revealLineInCenter).toHaveBeenLastCalledWith(3);
    expect([...code().zones.values()][1].afterLineNumber).toBe(3);
    expect(code().layoutZone).toHaveBeenLastCalledWith('zone-1');
    expect(code().layoutContentWidget).toHaveBeenCalledWith(code().content.get('glyph.review.hunk'));
    expect(code().content.get('glyph.review.hunk')!.getPosition()!.position).toEqual({ lineNumber: 3, column: 1 });
    full().next();
    expect(full().label).toBe('1 of 2');
    full().previous();
    expect(full().label).toBe('2 of 2');
  });

  it('stays on the first line of files without changes', async () => {
    const { editor, full, code } = harnessOf({ preview: (p, f) => previewOf(p, f, { items: [] }) });
    await editor.open('c1', 'p1', 'f1');

    full().next();

    expect(full().label).toBe('1 of 0');
    expect(full().itemId).toBeUndefined();
    expect(code().revealLineInCenter).toHaveBeenLastCalledWith(1);
    expect([...code().zones.values()][1].afterLineNumber).toBe(1);
    expect(code().content.get('glyph.review.hunk')!.getPosition()!.position).toEqual({ lineNumber: 1, column: 1 });
  });

  it('annotates files without changes', async () => {
    const { editor, actions, code } = harnessOf({ preview: (p, f) => previewOf(p, f, { items: [] }) });
    await editor.open('c1', 'p1', 'f1');
    code().select(new Selection(1, 1, 1, 4));

    editor.executeCommand(GlyphReviewCommand.ADD_TO_CHAT);

    await vi.waitFor(() => {
      expect(actions.annotate).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ sourceId: 'p1:f1:', quote: 'one' }),
      );
    });
  });

  it('keeps or undoes the current change and rereads the file', async () => {
    const { editor, actions, full, hunk } = harnessOf();
    await editor.open('c1', 'p1', 'f1');

    await hunk().keep();
    full().next();
    await full().undo();

    expect(actions.decide.mock.calls).toEqual([
      ['c1', [{ proposalId: 'p1', itemId: 'i1' }], true],
      ['c1', [{ proposalId: 'p1', itemId: 'i2' }], false],
    ]);
    expect(actions.read).toHaveBeenCalledTimes(3);
  });

  it('keeps or undoes the whole file and keeps everything in the chat', async () => {
    const { editor, actions, full } = harnessOf({
      state: stateOf([
        { id: 'p1', chatId: 'c1', files: [fileOf(), fileOf({ id: 'f3', pendingItemIds: [] })] },
        { id: 'p2', chatId: 'c1', files: [fileOf({ id: 'f2', pendingItemIds: ['j1'] })] },
        { id: 'p3', chatId: 'c2', files: [fileOf({ id: 'f4', pendingItemIds: ['k1'] })] },
      ]),
    });
    await editor.open('c1', 'p1', 'f1');

    await full().keepFile!();
    await full().undoFile!();
    await full().keepAll!();

    expect(actions.decide.mock.calls).toEqual([
      [
        'c1',
        [
          { proposalId: 'p1', itemId: 'i1' },
          { proposalId: 'p1', itemId: 'i2' },
        ],
        true,
      ],
      [
        'c1',
        [
          { proposalId: 'p1', itemId: 'i1' },
          { proposalId: 'p1', itemId: 'i2' },
        ],
        false,
      ],
      [
        'c1',
        [
          { proposalId: 'p1', itemId: 'i1' },
          { proposalId: 'p1', itemId: 'i2' },
          { proposalId: 'p2', itemId: 'j1' },
        ],
        true,
      ],
    ]);
    expect(full().fileLabel).toBe('1 of 2 Files');
  });

  it('navigates between files with pending changes', async () => {
    const { editor, actions, full } = harnessOf({
      state: stateOf([
        { id: 'p1', chatId: 'c1', files: [fileOf(), fileOf({ id: 'f3', pendingItemIds: [] })] },
        { id: 'p2', chatId: 'c1', files: [fileOf({ id: 'f2', pendingItemIds: ['j1'] })] },
      ]),
    });
    await editor.open('c1', 'p1', 'f1');

    await full().nextFile!();
    expect(actions.read).toHaveBeenLastCalledWith('c1', 'p2', 'f2');
    await full().nextFile!();
    expect(actions.read).toHaveBeenLastCalledWith('c1', 'p1', 'f1');
    await full().previousFile!();
    expect(actions.read).toHaveBeenLastCalledWith('c1', 'p2', 'f2');

    await editor.open('c1', 'p1', 'f3');
    expect(full().fileLabel).toBe('0 of 2 Files');
    expect(full().label).toBe('Review complete');
    await full().previousFile!();
    expect(actions.read).toHaveBeenLastCalledWith('c1', 'p2', 'f2');
    await editor.open('c1', 'p1', 'f3');
    await full().nextFile!();
    expect(actions.read).toHaveBeenLastCalledWith('c1', 'p1', 'f1');
  });

  it('stays put when no file has pending changes', async () => {
    const { editor, actions, full } = harnessOf({
      state: stateOf([{ id: 'p1', chatId: 'c1', files: [fileOf({ pendingItemIds: [] })] }]),
    });
    await editor.open('c1', 'p1', 'f1');

    await full().nextFile!();

    expect(actions.read).toHaveBeenCalledTimes(1);
    expect(full().navigationDisabled).toBe(true);
  });

  it('rejects a change with a comment on the reviewed passage', async () => {
    const { editor, actions, hunk, code, model } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    code().select(new Selection(2, 1, 2, 4));

    await hunk().rejectWithComment!('Keep lowercase');

    expect(actions.decide).toHaveBeenCalledWith('c1', [{ proposalId: 'p1', itemId: 'i1' }], false, 'Keep lowercase');
    expect(actions.annotate).toHaveBeenCalledWith('c1', {
      id: expect.any(String),
      order: 1,
      kind: 'proposal',
      sourceId: 'p1:f1:i1',
      revision: `${model().id}:${model().getVersionId()}`,
      label: 'src/a.ts',
      quote: 'TWO',
      from: 4,
      to: 7,
      comment: 'Keep lowercase',
    });
    expect(actions.read).toHaveBeenCalledTimes(2);
  });

  it('quotes the whole file when nothing is selected', async () => {
    const { editor, actions, hunk, setState } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    setState(stateOf([{ id: 'p1', chatId: 'c1', files: [fileOf({ pendingItemIds: [] })] }]));

    await hunk().rejectWithComment!('Drop it');

    expect(actions.annotate).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ quote: 'one\nTWO\nthree\n', from: 0, to: 14 }),
    );
    expect(actions.read).toHaveBeenCalledTimes(1);
  });

  it('rejects without annotating read-only chats, empty files, or detached editors', async () => {
    const setups = [
      { harness: { state: stateOf(undefined, true) }, detach: false },
      { harness: { preview: (p: string, f: string) => previewOf(p, f, { after: '' }) }, detach: false },
      { harness: {}, detach: true },
    ];
    for (const { harness, detach } of setups) {
      const { editor, actions, hunk, code } = harnessOf(harness);
      await editor.open('c1', 'p1', 'f1');
      const controls = hunk();
      if (detach) code().changeModel(null);

      await controls.rejectWithComment!('No');

      expect(actions.decide).toHaveBeenCalledWith('c1', [{ proposalId: 'p1', itemId: 'i1' }], false, 'No');
      expect(actions.annotate).not.toHaveBeenCalled();
    }
  });

  it('disables controls for read-only chats', async () => {
    const { editor, full } = harnessOf({ state: stateOf(undefined, true) });

    await editor.open('c1', 'p1', 'f1');

    expect(full()).toEqual(
      expect.objectContaining({ disabled: true, navigationDisabled: true, keepAllDisabled: true, keepDisabled: true }),
    );
  });

  it('hides the change controls once the file is reviewed', async () => {
    const { editor, full, code, setState } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    setState(stateOf([{ id: 'p1', chatId: 'c1', files: [fileOf({ pendingItemIds: [] })] }]));

    editor.changed();

    expect(full()).toEqual(expect.objectContaining({ label: 'Review complete', fileComplete: true, disabled: true }));
    const hunk = code().content.get('glyph.review.hunk')!;
    expect(hunk.getDomNode().style.display).toBe('none');
    expect([...code().zones.values()][1].heightInPx).toBe(0);
    expect(code().layoutZone).toHaveBeenLastCalledWith('zone-1');
  });

  it('disables keeping changes that cannot be applied', async () => {
    const cases: [Partial<FakeFile>, boolean, boolean][] = [
      [{ textOnly: false }, true, true],
      [{ textOnly: false, autoApplied: true }, false, false],
      [{ applicability: GlyphProposalApplicability.STALE }, true, true],
      [{ applicability: GlyphProposalApplicability.APPLYING }, true, true],
      [{ applicability: GlyphProposalApplicability.FAILED_RETRYABLE }, false, false],
    ];
    for (const [file, keepDisabled, keepAllDisabled] of cases) {
      const { editor, full } = harnessOf({ state: stateOf([{ id: 'p1', chatId: 'c1', files: [fileOf(file)] }]) });

      await editor.open('c1', 'p1', 'f1');

      expect([full().keepDisabled, full().keepAllDisabled]).toEqual([keepDisabled, keepAllDisabled]);
    }
  });

  it('refreshes when keybindings change', async () => {
    const { editor, view, services, keybindingsUpdated } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    services.keybindings.lookupKeybinding.mockReturnValue({ getLabel: () => 'K' });

    keybindingsUpdated.fire();

    expect(view(true).controls.shortcuts![GlyphReviewCommand.NEXT_FILE]).toBe('K');
    expect(view(false).update).toHaveBeenCalled();
  });

  it('resizes the control zones to their content and follows the editor layout', async () => {
    const { editor, view, code } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    code().layoutZone.mockClear();

    (view(true).node.firstElementChild as HTMLElement).style.height = '64px';
    await vi.waitFor(() => {
      expect([...code().zones.values()][0].heightInPx).toBe(64);
    });
    expect(code().layoutZone).toHaveBeenCalledWith('zone-0');

    code().layoutInfo = { width: 500, contentWidth: 400, verticalScrollbarWidth: 10, contentLeft: 60 };
    code().layout();
    expect(view(true).node.style.width).toBe('490px');
    expect(view(false).node.style.width).toBe('390px');
    expect(code().layoutOverlayWidget).toHaveBeenCalledWith(code().overlay.get('glyph.review.file'));
    expect(code().layoutContentWidget).toHaveBeenCalledWith(code().content.get('glyph.review.hunk'));
  });

  it('leaves empty control zones at their initial height', async () => {
    const { editor, code } = harnessOf({ reviewContent: false });

    await editor.open('c1', 'p1', 'f1');

    expect([...code().zones.values()].map(zone => zone.heightInPx)).toEqual([40, 40]);
  });

  it('tracks whether a text field inside the editor has focus', async () => {
    const { editor, code } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    const textInput = code().keys.get('glyph.reviewTextInput')!;
    const focus = (target: Node) => target.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const field = document.createElement('input');
    const inputArea = document.createElement('textarea');
    inputArea.className = 'inputarea';
    const text = document.createTextNode('x');
    code().dom.append(field, inputArea, text);

    focus(field);
    expect(textInput.value).toBe(true);
    focus(inputArea);
    expect(textInput.value).toBe(false);
    focus(field);
    focus(text);
    expect(textInput.value).toBe(false);
  });

  it('opens editors that have no DOM yet', async () => {
    const { editor, code, full } = harnessOf({ dom: false });

    await editor.open('c1', 'p1', 'f1');

    expect(full().label).toBe('1 of 2');
    expect(code().keys.get('glyph.reviewTextInput')!.value).toBe(false);
  });

  it('counts no changes for a pending file whose preview has not arrived', async () => {
    const { editor } = harnessOf({ preview: () => undefined });
    await expect(editor.open('c1', 'p1', 'f1')).rejects.toMatchObject({ code: GlyphDesktopErrorCode.NOT_FOUND });

    const controls = (editor as unknown as { properties(full: boolean): GlyphReviewControls }).properties(true);

    expect(controls.label).toBe('1 of 0');
    expect(controls.itemId).toBeUndefined();
  });

  it('stays on the first change when moving before a preview arrives', async () => {
    const { editor } = harnessOf({ preview: () => undefined });
    await expect(editor.open('c1', 'p1', 'f1')).rejects.toMatchObject({ code: GlyphDesktopErrorCode.NOT_FOUND });
    const internals = editor as unknown as {
      move(amount: number): void;
      properties(full: boolean): GlyphReviewControls;
    };

    internals.move(1);

    expect(internals.properties(true).label).toBe('1 of 0');
  });

  it('decides nothing before a file is opened', async () => {
    const { editor, actions } = harnessOf();

    await (editor as unknown as { decide(scope: 'item' | 'file' | 'all', accept: boolean): Promise<void> }).decide(
      'all',
      true,
    );

    expect(actions.decide).not.toHaveBeenCalled();
    expect(actions.read).not.toHaveBeenCalled();
  });

  it('installs no review controls before a file is shown', () => {
    const { editor, reviews } = harnessOf();

    (editor as unknown as { installControls(): void }).installControls();

    expect(reviews).toEqual([]);
    expect(mounts.mountGlyphReview).not.toHaveBeenCalled();
  });

  describe(GlyphProposalEditor.prototype.executeCommand, () => {
    it('routes review commands to the controls that registered for them', async () => {
      const { editor, full, hunk } = harnessOf();
      editor.executeCommand(GlyphReviewCommand.KEEP);
      await editor.open('c1', 'p1', 'f1');
      const fileCommands = vi.fn();
      const changeCommands = vi.fn();
      const staleCommands = vi.fn();
      const releaseStale = full().registerCommands!(staleCommands);
      full().registerCommands!(fileCommands);
      const releaseChange = hunk().registerCommands!(changeCommands);

      releaseStale();
      for (const command of Object.values(GlyphReviewCommand)) editor.executeCommand(command);
      releaseChange();
      editor.executeCommand(GlyphReviewCommand.KEEP);

      expect(changeCommands.mock.calls).toEqual([
        [GlyphReviewCommand.KEEP],
        [GlyphReviewCommand.UNDO],
        [GlyphReviewCommand.COMMENT],
      ]);
      expect(fileCommands.mock.calls).toEqual([
        [GlyphReviewCommand.PREVIOUS_CHANGE],
        [GlyphReviewCommand.NEXT_CHANGE],
        [GlyphReviewCommand.PREVIOUS_FILE],
        [GlyphReviewCommand.NEXT_FILE],
        [GlyphReviewCommand.KEEP_FILE],
        [GlyphReviewCommand.UNDO_FILE],
        [GlyphReviewCommand.KEEP_ALL],
      ]);
      expect(staleCommands).not.toHaveBeenCalled();
    });

    it('adds a non-empty selection to Chat', async () => {
      const { editor, actions, code } = harnessOf();
      editor.executeCommand(GlyphReviewCommand.ADD_TO_CHAT);
      await editor.open('c1', 'p1', 'f1');
      editor.executeCommand(GlyphReviewCommand.ADD_TO_CHAT);
      code().select(new Selection(2, 2, 2, 2));
      editor.executeCommand(GlyphReviewCommand.ADD_TO_CHAT);
      code().select(new Selection(3, 1, 3, 6));

      editor.executeCommand(GlyphReviewCommand.ADD_TO_CHAT);

      await vi.waitFor(() => {
        expect(actions.annotate).toHaveBeenCalledTimes(1);
      });
      expect(actions.annotate).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ quote: 'three', from: 8, to: 13, comment: '', sourceId: 'p1:f1:i1' }),
      );
    });

    it('reports passages too long to annotate', async () => {
      const { editor, actions, code } = harnessOf({
        preview: (p, f) => previewOf(p, f, { after: 'x'.repeat(50001) }),
      });
      await editor.open('c1', 'p1', 'f1');
      code().select(new Selection(1, 1, 1, 50002));

      editor.executeCommand(GlyphReviewCommand.ADD_TO_CHAT);

      await vi.waitFor(() => {
        expect(actions.report).toHaveBeenCalledWith(
          expect.objectContaining({
            code: GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
            message: 'Select a passage shorter than 50,000 characters to annotate.',
          }),
        );
      });
      expect(actions.annotate).not.toHaveBeenCalled();
    });

    it('annotates under a default label when the file is gone', async () => {
      const { editor, actions, code, setState } = harnessOf();
      await editor.open('c1', 'p1', 'f1');
      setState(stateOf([]));
      code().select(new Selection(1, 1, 1, 4));

      editor.executeCommand(GlyphReviewCommand.ADD_TO_CHAT);

      await vi.waitFor(() => {
        expect(actions.annotate).toHaveBeenCalledWith('c1', expect.objectContaining({ label: 'Proposal' }));
      });
    });
  });

  it('adds nothing to Chat from read-only chats', async () => {
    const { editor, actions, code } = harnessOf({ state: stateOf(undefined, true) });
    await editor.open('c1', 'p1', 'f1');
    code().select(new Selection(1, 1, 1, 4));

    editor.executeCommand(GlyphReviewCommand.ADD_TO_CHAT);
    await Promise.resolve();

    expect(actions.annotate).not.toHaveBeenCalled();
    expect(actions.report).not.toHaveBeenCalled();
  });

  it('offers to add a selection to Chat beside it', async () => {
    const { editor, services, code, buttons, actions } = harnessOf();
    services.keybindings.lookupKeybinding.mockImplementation(command =>
      command === (GlyphReviewCommand.ADD_TO_CHAT as string) ? { getLabel: () => '⌘L' } : undefined,
    );
    await editor.open('c1', 'p1', 'f1');

    code().select(new Selection(2, 1, 2, 4));
    const widget = code().content.get('glyph.annotation.selection')!;
    code().select(new Selection(3, 1, 3, 3));

    expect(buttons).toHaveLength(2);
    expect(buttons[0].dispose).toHaveBeenCalled();
    expect(buttons[1].shortcut).toBe('⌘L');
    expect(widget.getDomNode()).toBe(buttons[0].node);
    expect(code().content.get('glyph.annotation.selection')!.getPosition()).toEqual({
      position: new Position(3, 3),
      preference: [ContentWidgetPositionPreference.BELOW],
    });
    buttons[1].open();
    await vi.waitFor(() => {
      expect(actions.annotate).toHaveBeenCalledWith('c1', expect.objectContaining({ quote: 'th' }));
    });
  });

  it('withholds the selection button for empty selections, annotations in progress, or submissions', async () => {
    const { editor, code, composer, buttons } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    const snapshots: ComposerSnapshot[] = [
      { document: {}, annotationDraft: annotationOf(code().model!) },
      { document: {}, editingAnnotation: 'annotation-1' },
      { document: {}, submitting: true },
    ];

    code().select(null);
    code().select(new Selection(2, 2, 2, 2));
    for (const snapshot of snapshots) {
      composer.snapshot = snapshot;
      code().select(new Selection(2, 1, 2, 4));
    }

    expect(buttons).toEqual([]);
    expect(code().content.has('glyph.annotation.selection')).toBe(false);
  });

  it('removes the selection button when an annotation starts', async () => {
    for (const snapshot of [
      { document: {}, editingAnnotation: 'annotation-1' },
      { document: {}, submitting: true },
    ] as ComposerSnapshot[]) {
      const { editor, code, composer, buttons } = harnessOf();
      await editor.open('c1', 'p1', 'f1');
      code().select(new Selection(2, 1, 2, 4));

      composer.publish(snapshot);

      expect(buttons[0].dispose).toHaveBeenCalled();
      expect(code().content.has('glyph.annotation.selection')).toBe(false);
    }
  });

  it('removes the selection button when the editor detaches', async () => {
    const { editor, code, buttons } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    code().select(new Selection(2, 1, 2, 4));

    code().dispose();

    expect(buttons[0].dispose).toHaveBeenCalled();
  });

  it('keeps the cursor in place while a message is submitting', async () => {
    const { editor, code, composer, markers } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    const annotations = [annotationOf(code().model!)];

    composer.publish({ document: { options: { annotations } }, submitting: true });
    code().position = new Position(2, 2);
    composer.publish({ document: { options: { annotations } }, submitting: true });

    expect(code().setPosition).toHaveBeenCalledTimes(1);
    expect(code().setPosition).toHaveBeenCalledWith(new Position(2, 2));
    expect(markers).toEqual([]);
  });

  it('marks annotations on this file in the gutter', async () => {
    const { editor, code, composer, markers } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    const model = code().model!;
    const annotations = [
      annotationOf(model),
      annotationOf(model, { id: 'chat', kind: 'chat' }),
      annotationOf(model, { id: 'stale', revision: 'other:1' }),
      annotationOf(model, { id: 'elsewhere', sourceId: 'p1:f2:i1' }),
      annotationOf(model, { id: 'edited', quote: 'two' }),
    ];

    composer.publish({ document: { options: { annotations } } });

    expect(markers.map(marker => [marker.order, marker.comment])).toEqual([[2, 'Why?']]);
    expect([...code().glyph.keys()]).toEqual(['glyph.annotation.annotation-1']);
    const widget = code().glyph.get('glyph.annotation.annotation-1')!;
    expect(widget.getDomNode()).toBe(markers[0].node);
    expect(widget.getPosition()).toEqual({
      lane: GlyphMarginLane.Right,
      zIndex: 12,
      range: { startLineNumber: 2, endLineNumber: 2, startColumn: 1, endColumn: 1 },
    });
    expect(code().margin.hasAttribute('aria-hidden')).toBe(false);
    markers[0].open();
    expect(composer.editAnnotation).toHaveBeenCalledWith('annotation-1');

    composer.publish({ document: {} });

    expect(code().glyph.size).toBe(0);
    expect(markers[0].dispose).toHaveBeenCalled();
    expect(code().margin.getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves an exposed gutter exposed after markers are removed', async () => {
    const { editor, code, composer } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    code().margin.removeAttribute('aria-hidden');

    composer.publish({ document: { options: { annotations: [annotationOf(code().model!)] } } });
    composer.publish({ document: {} });

    expect(code().margin.hasAttribute('aria-hidden')).toBe(false);
  });

  it('marks annotations in editors without a gutter', async () => {
    const { editor, code, composer, markers } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    code().margin.remove();

    composer.publish({ document: { options: { annotations: [annotationOf(code().model!)] } } });

    expect(markers).toHaveLength(1);
  });

  it('draws no markers once the editor shows nothing', async () => {
    const { editor, code, composer, markers } = harnessOf();
    await editor.open('c1', 'p1', 'f1');
    const annotations = [annotationOf(code().model!)];
    code().model = null;

    composer.publish({ document: { options: { annotations } } });

    expect(markers).toEqual([]);
  });

  describe(GlyphProposalEditor.prototype.acceptPreview, () => {
    it('ignores previews of other files', async () => {
      const { editor, services } = harnessOf();
      editor.acceptPreview(previewOf());
      await editor.open('c1', 'p1', 'f1');
      services.models.createModel.mockClear();

      editor.acceptPreview(previewOf('p2', 'f1'));
      editor.acceptPreview(previewOf('p1', 'f2'));

      expect(services.models.createModel).not.toHaveBeenCalled();
    });

    it('updates its documents in place and keeps the current change in range', async () => {
      const { editor, full, model, models } = harnessOf();
      await editor.open('c1', 'p1', 'f1');
      full().next();
      const before = [...models.values()][0];
      const beforeVersion = before.getVersionId();

      editor.acceptPreview(previewOf('p1', 'f1', { after: 'one\nthree\n', items: [{ id: 'i2', lineNumber: 2 }] }));

      expect(before.getVersionId()).toBe(beforeVersion);
      expect(model().getValue()).toBe('one\nthree\n');
      expect(full().label).toBe('1 of 1');
      expect(full().itemId).toBe('i2');
    });
  });

  describe(GlyphProposalEditor.prototype.refresh, () => {
    it('rereads files with pending changes and otherwise only redraws', async () => {
      const { editor, actions, view, setState } = harnessOf();
      await editor.refresh();
      await editor.open('c1', 'p1', 'f1');

      await editor.refresh();
      expect(actions.read).toHaveBeenCalledTimes(2);

      setState(stateOf([{ id: 'p1', chatId: 'c1', files: [fileOf({ pendingItemIds: [] })] }]));
      view(true).update.mockClear();
      await editor.refresh();
      expect(actions.read).toHaveBeenCalledTimes(2);
      expect(view(true).update).toHaveBeenCalled();
    });
  });

  describe(GlyphProposalEditor.prototype.revealAnnotation, () => {
    it('selects the annotated passage and opens an inline editor below it', async () => {
      const { editor, code, actions } = harnessOf();
      await editor.open('c1', 'p1', 'f1');
      const bounds = code().dom.getBoundingClientRect();

      const position = await editor.revealAnnotation(annotationOf(code().model!));

      expect(actions.read).toHaveBeenCalledTimes(1);
      expect(
        code()
          .getSelection()!
          .equalsSelection(new Selection(2, 1, 2, 4)),
      ).toBe(true);
      expect(code().revealPositionInCenterIfOutsideViewport).toHaveBeenCalledWith(
        new Position(2, 1),
        ScrollType.Immediate,
      );
      const inline = code().overlay.get('glyph.annotation.editor')!;
      expect(position).toEqual({
        container: inline.getDomNode(),
        x: bounds.left + 10,
        y: bounds.top + 38,
        minX: bounds.left + 60,
        maxX: bounds.right,
      });
      expect(inline.getPosition()).toBeNull();
      const node = inline.getDomNode();
      expect([node.style.width, node.style.left, node.style.padding]).toEqual(['684px', '60px', '8px']);
      const zone = [...code().zones.values()].at(-1)!;
      expect([zone.afterLineNumber, zone.heightInPx, zone.showInHiddenAreas]).toEqual([1, 128, true]);
      zone.onDomNodeTop!(42);
      expect(node.style.top).toBe('42px');
    });

    it('resizes the inline editor to its content and follows the editor layout', async () => {
      const { editor, code } = harnessOf();
      await editor.open('c1', 'p1', 'f1');
      const position = await editor.revealAnnotation(annotationOf(code().model!));
      const node = position!.container!;
      const zone = [...code().zones.values()].at(-1)!;
      code().layoutZone.mockClear();

      const body = document.createElement('div');
      body.style.height = '300px';
      node.append(body);
      await vi.waitFor(() => {
        expect(zone.heightInPx).toBe(316);
      });
      expect(code().layoutZone).toHaveBeenCalledTimes(1);
      code().layoutInfo = { ...code().layoutInfo, contentWidth: 300, contentLeft: 40 };
      code().layout();

      expect([node.style.width, node.style.left]).toEqual(['284px', '40px']);
      expect(code().layoutOverlayWidget).toHaveBeenCalledWith(code().overlay.get('glyph.annotation.editor'));
    });

    it('keeps a short inline editor at its minimum height', async () => {
      const { editor, code } = harnessOf();
      await editor.open('c1', 'p1', 'f1');
      code().layoutZone.mockClear();

      await editor.revealAnnotation(annotationOf(code().model!));
      const inline = code().overlay.get('glyph.annotation.editor')!;

      await vi.waitFor(() => {
        expect(code().layoutOverlayWidget).toHaveBeenCalledTimes(2);
      });
      expect(code().layoutOverlayWidget).toHaveBeenCalledWith(inline);
      expect([...code().zones.values()].at(-1)!.heightInPx).toBe(128);
      expect(code().layoutZone).not.toHaveBeenCalled();
    });

    it('closes the inline editor once no annotation is being edited', async () => {
      const { editor, code, composer } = harnessOf();
      await editor.open('c1', 'p1', 'f1');
      await editor.revealAnnotation(annotationOf(code().model!));
      const zones = code().zones.size;

      composer.publish({ document: {}, editingAnnotation: 'annotation-1' });
      expect(code().overlay.has('glyph.annotation.editor')).toBe(true);
      composer.publish({ document: {} });

      expect(code().overlay.has('glyph.annotation.editor')).toBe(false);
      expect(code().zones.size).toBe(zones - 1);
    });

    it('opens the annotated file when it is not showing', async () => {
      const { editor, actions, codes, models } = harnessOf({
        state: stateOf([{ id: 'p1', chatId: 'c1', files: [fileOf(), fileOf({ id: 'f2', path: 'src/b.ts' })] }]),
      });
      const annotation = () =>
        annotationOf(models.get('glyph-proposal:/p1/f2/after/b.ts')!, {
          sourceId: 'p1:f2:i1',
          from: 0,
          to: 3,
          quote: 'one',
        });

      await editor.open('c1', 'p1', 'f1');
      await editor.open('c1', 'p1', 'f2');
      await editor.open('c1', 'p1', 'f1');
      await expect(editor.revealAnnotation(annotation())).resolves.toEqual(
        expect.objectContaining({ x: expect.any(Number) }),
      );
      expect(actions.read).toHaveBeenLastCalledWith('c1', 'p1', 'f2');
      codes.at(-1)!.dom.remove();
      await editor.revealAnnotation(annotation());

      expect(actions.read).toHaveBeenCalledTimes(5);
    });

    it('reveals nothing for unknown, stale, or edited annotations', async () => {
      const { editor, code, setState } = harnessOf();
      await editor.open('c1', 'p1', 'f1');
      const model = code().model!;

      expect(await editor.revealAnnotation(annotationOf(model, { sourceId: 'p9:f1:i1' }))).toBeUndefined();
      expect(await editor.revealAnnotation(annotationOf(model, { sourceId: 'p1' }))).toBeUndefined();
      expect(await editor.revealAnnotation(annotationOf(model, { revision: 'stale:1' }))).toBeUndefined();
      expect(await editor.revealAnnotation(annotationOf(model, { quote: 'two' }))).toBeUndefined();
      setState(stateOf([{ id: 'p1', files: [fileOf()] }]));
      expect(await editor.revealAnnotation(annotationOf(model))).toBeUndefined();
      expect(code().overlay.has('glyph.annotation.editor')).toBe(false);
    });

    it('reveals nothing when the annotated file shows no document', async () => {
      const { editor, services } = harnessOf();
      services.editors.openEditor.mockResolvedValueOnce(undefined);

      await expect(
        editor.revealAnnotation({
          id: 'annotation-1',
          order: 1,
          kind: 'proposal',
          sourceId: 'p1:f1:i1',
          revision: 'model:1',
          label: 'src/a.ts',
          quote: 'TWO',
          from: 4,
          to: 7,
          comment: '',
        }),
      ).resolves.toBeUndefined();
    });

    it('omits a position for passages scrolled out of view', async () => {
      const { editor, code } = harnessOf();
      await editor.open('c1', 'p1', 'f1');
      code().getScrolledVisiblePosition.mockReturnValueOnce(null);

      await expect(editor.revealAnnotation(annotationOf(code().model!))).resolves.toBeUndefined();
      expect(code().overlay.has('glyph.annotation.editor')).toBe(true);
    });
  });
});
