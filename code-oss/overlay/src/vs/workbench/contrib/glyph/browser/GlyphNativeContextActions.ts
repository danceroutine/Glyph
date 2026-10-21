import type { GlyphTurnOptions } from '#glyph/protocol/events/GlyphAnnotation.js';
import { Disposable, DisposableStore, toDisposable } from '#vs/base/common/lifecycle.js';
import { ICodeEditor } from '#vs/editor/browser/editorBrowser.js';
import { IModelDecoration } from '#vs/editor/common/model.js';
import { IMarkerDecorationsService } from '#vs/editor/common/services/markerDecorations.js';
import { Range } from '#vs/editor/common/core/range.js';
import { MarkerHover } from '#vs/editor/contrib/hover/browser/markerHoverParticipant.js';
import {
  HoverAnchor,
  HoverAnchorType,
  IEditorHoverRenderContext,
  RenderedHoverParts,
} from '#vs/editor/contrib/hover/browser/hoverTypes.js';
import { INotificationService } from '#vs/platform/notification/common/notification.js';
import { IKeybindingService } from '#vs/platform/keybinding/common/keybinding.js';
import { IViewsService } from '#vs/workbench/services/views/common/viewsService.js';
import { ITerminalService, ITerminalInstance } from '#vs/workbench/contrib/terminal/browser/terminal.js';
import { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import { GlyphViewPane } from './GlyphViewPane.js';
import { mountGlyphContextButton } from './ui/mountGlyphWorkbench.js';
import type { GlyphContextAttachment } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import { AgentModeID } from '#glyph/protocol/index.js';

/** Keep unrelated drafts in the composer's existing unsent-message history. */
export async function useGlyphContext(
  glyph: GlyphWorkbenchService,
  views: IViewsService,
  capture: () => Promise<readonly GlyphContextAttachment[]>,
  prompt?: string,
  mode?: AgentModeID,
  options?: GlyphTurnOptions,
): Promise<void> {
  const composer = glyph.composer;
  const document = composer.snapshot.document;
  const attachments = await capture();
  if (!attachments.length) return;
  if (glyph.composer !== composer || composer.snapshot.document !== document)
    throw new Error('The active draft changed during capture. Please try again.');
  if (prompt)
    composer.restoreDraft({
      parts: [{ type: 'text', text: prompt }],
      from: prompt.length,
      to: prompt.length,
      options: { ...options, ...(mode ? { mode } : {}) },
    });
  composer.insertAttachments(attachments);
  const actionDocument = composer.snapshot.document;
  await views.openView(GlyphViewPane.ID, true);
  if (glyph.composer !== composer || composer.snapshot.document !== actionDocument)
    throw new Error('The active draft changed while opening Chat. Review the draft before trying again.');
  composer.focus();
  if (prompt) await composer.submit((text, captured, options) => glyph.send(text, captured, options));
}

/** Adds an action to the existing diagnostic hover; the marker remains owned by the editor. */
export class GlyphDiagnosticHover {
  readonly hoverOrdinal = 1.1;
  constructor(
    private readonly editor: ICodeEditor,
    @IMarkerDecorationsService private readonly markers: IMarkerDecorationsService,
    @GlyphWorkbenchService private readonly glyph: GlyphWorkbenchService,
    @IViewsService private readonly views: IViewsService,
    @INotificationService private readonly notifications: INotificationService,
  ) {}
  computeSync(anchor: HoverAnchor, decorations: IModelDecoration[]): MarkerHover[] {
    const model = this.editor.getModel();
    if (!model || (anchor.type !== HoverAnchorType.Range && !anchor.supportsMarkerHover)) return [];
    return decorations.flatMap(decoration => {
      const marker = this.markers.getMarker(model.uri, decoration);
      return marker ? [new MarkerHover(this, Range.lift(decoration.range), marker)] : [];
    });
  }
  renderHoverParts(context: IEditorHoverRenderContext, parts: MarkerHover[]): RenderedHoverParts<MarkerHover> {
    return new RenderedHoverParts(
      parts.map(hoverPart => {
        const hoverElement = document.createElement('div');
        hoverElement.style.padding = '6px 10px';
        context.fragment.append(hoverElement);
        const button = mountGlyphContextButton(
          hoverElement,
          'Fix with Agent',
          () => {
            context.hide();
            void useGlyphContext(
              this.glyph,
              this.views,
              () => this.glyph.ideContext.captureDiagnostic(hoverPart.marker),
              'Fix the attached diagnostic. Check whether it still applies to the current source before making changes.',
              AgentModeID.AGENT,
            ).catch(error => this.notifications.error(error));
          },
          true,
        );
        return { hoverPart, hoverElement, dispose: () => button.dispose() };
      }),
    );
  }
  getAccessibleContent(): string {
    return 'Fix with Agent';
  }
}

/** Selection actions follow each real terminal instance, including editor terminals. */
export class GlyphTerminalSelectionActions extends Disposable {
  static readonly ID = 'glyph.terminalSelectionActions';
  constructor(
    @ITerminalService terminals: ITerminalService,
    @GlyphWorkbenchService glyph: GlyphWorkbenchService,
    @IViewsService views: IViewsService,
    @INotificationService notifications: INotificationService,
    @IKeybindingService keybindings: IKeybindingService,
  ) {
    super();
    const watch = (terminal: ITerminalInstance) => {
      const store = new DisposableStore();
      this._register(store);
      let dismissedSelection: string | undefined;
      let host: HTMLElement | undefined;
      let button: { dispose(): void } | undefined;
      const clear = () => {
        button?.dispose();
        button = undefined;
        host?.remove();
        host = undefined;
      };
      const update = () => {
        clear();
        if (!terminal.selection) dismissedSelection = undefined;
        if (terminal.selection && terminal.selection === dismissedSelection) return;
        const xterm = terminal.xterm?.raw;
        const selection = xterm?.getSelectionPosition();
        const screen = terminal.domElement?.querySelector('.xterm-screen');
        if (!terminal.hasFocus || !selection || !terminal.selection || !screen || !xterm) return;
        const bounds = screen.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        const row = selection.start.y - xterm.buffer.active.viewportY;
        if (row < 0 || row >= xterm.rows) return;
        host = document.createElement('div');
        Object.assign(host.style, {
          position: 'fixed',
          zIndex: '1000',
          background: 'var(--vscode-editorWidget-background)',
          borderRadius: '6px',
        });
        terminal.domElement.append(host);
        button = mountGlyphContextButton(
          host,
          'Add to Chat',
          () => {
            const selected = terminal.selection;
            void useGlyphContext(glyph, views, () => glyph.ideContext.terminal(terminal))
              .then(() => {
                dismissedSelection = selected;
                clear();
              })
              .catch(error => notifications.error(error));
          },
          false,
          keybindings.lookupKeybinding('glyph.attachTerminalSelection')?.getLabel() ?? undefined,
        );
        const size = host.getBoundingClientRect();
        host.style.left = `${Math.max(bounds.left, bounds.right - size.width - 8)}px`;
        host.style.top = `${Math.max(bounds.top, bounds.top + (row * bounds.height) / xterm.rows - size.height)}px`;
      };
      store.add(terminal.onDidChangeSelection(update));
      store.add(terminal.onDidFocus(update));
      store.add(terminal.onDidBlur(clear));
      store.add(terminal.onDisposed(() => store.dispose()));
      store.add(toDisposable(clear));
      void terminal.xtermReadyPromise.then(xterm => {
        if (store.isDisposed || !xterm) return;
        store.add(xterm.raw.onScroll(update));
        store.add(xterm.raw.onResize(update));
        const observer = new ResizeObserver(update);
        observer.observe(terminal.domElement);
        store.add(toDisposable(() => observer.disconnect()));
      });
    };
    terminals.instances.forEach(watch);
    this._register(terminals.onDidCreateInstance(watch));
  }
}
