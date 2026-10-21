import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Emitter } from '#vs/base/common/event.js';
import { URI } from '#vs/base/common/uri.js';
import { Range } from '#vs/editor/common/core/range.js';
import { HoverForeignElementAnchor, HoverRangeAnchor } from '#vs/editor/contrib/hover/browser/hoverTypes.js';
import type { IEditorHoverRenderContext } from '#vs/editor/contrib/hover/browser/hoverTypes.js';
import type { ICodeEditor } from '#vs/editor/browser/editorBrowser.js';
import type { IModelDecoration } from '#vs/editor/common/model.js';
import type { ITerminalInstance, ITerminalService } from '#vs/workbench/contrib/terminal/browser/terminal.js';
import { AgentModeID } from '#glyph/protocol/index.js';
import type { GlyphContextAttachment } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import type { GlyphWorkbenchService } from '#vs/workbench/contrib/glyph/common/GlyphWorkbenchService.js';
import type { IViewsService } from '#vs/workbench/services/views/common/viewsService.js';
import { GlyphViewPane } from '#vs/workbench/contrib/glyph/browser/GlyphViewPane.js';
import {
  GlyphDiagnosticHover,
  GlyphTerminalSelectionActions,
  useGlyphContext,
} from '#vs/workbench/contrib/glyph/browser/GlyphNativeContextActions.js';

const mounts = vi.hoisted(() => ({
  mountGlyphContextButton: vi.fn(),
  mountGlyphWorkbench: vi.fn(),
}));
vi.mock('#code-oss/ui/mountGlyphWorkbench.tsx', () => mounts);

const attachmentOf = (path = 'a.ts') =>
  ({ kind: 'file', uri: `file:///repo/${path}`, path, text: 'source', contentRevision: '1' }) as GlyphContextAttachment;

const composerOf = () => {
  const composer = {
    snapshot: { document: { parts: [] as unknown[] } },
    restoreDraft: vi.fn(),
    insertAttachments: vi.fn(() => {
      composer.snapshot = { document: { parts: ['attached'] } };
    }),
    focus: vi.fn(),
    submit: vi.fn(async (send: (text: string, attachments: unknown[], options: unknown) => Promise<void>) =>
      send('submitted', [attachmentOf()], { mode: AgentModeID.AGENT }),
    ),
  };
  return composer;
};

const glyphOf = () => {
  const composer = composerOf();
  const glyph = {
    composer,
    send: vi.fn(async () => {}),
    ideContext: {
      captureDiagnostic: vi.fn(async () => [attachmentOf('diagnostic.ts')]),
      terminal: vi.fn(async () => [attachmentOf('terminal.txt')]),
    },
  };
  return { glyph, composer, service: glyph as unknown as GlyphWorkbenchService };
};

const viewsOf = (opening?: () => void) => {
  const openView = vi.fn(async () => {
    opening?.();
    return undefined;
  });
  return { openView, views: { openView } as unknown as IViewsService };
};

const buttonOf = () => {
  const button = { dispose: vi.fn() };
  mounts.mountGlyphContextButton.mockReturnValueOnce(button);
  return button;
};

const lastButtonAction = () => mounts.mountGlyphContextButton.mock.lastCall![2] as () => void;

describe(useGlyphContext, () => {
  it('attaches the captured context and submits the prompt in the requested mode', async () => {
    const { glyph, composer, service } = glyphOf();
    const { openView, views } = viewsOf();
    const capture = vi.fn(async () => [attachmentOf()]);

    await useGlyphContext(service, views, capture, 'Fix it', AgentModeID.AGENT, { effort: 'high' } as never);

    expect(composer.restoreDraft).toHaveBeenCalledWith({
      parts: [{ type: 'text', text: 'Fix it' }],
      from: 6,
      to: 6,
      options: { effort: 'high', mode: AgentModeID.AGENT },
    });
    expect(composer.insertAttachments).toHaveBeenCalledWith([attachmentOf()]);
    expect(openView).toHaveBeenCalledWith(GlyphViewPane.ID, true);
    expect(composer.focus).toHaveBeenCalled();
    expect(glyph.send).toHaveBeenCalledWith('submitted', [attachmentOf()], { mode: AgentModeID.AGENT });
  });

  it('keeps the draft options when no mode is requested', async () => {
    const { composer, service } = glyphOf();

    await useGlyphContext(service, viewsOf().views, async () => [attachmentOf()], 'Explain');

    expect(composer.restoreDraft).toHaveBeenCalledWith(expect.objectContaining({ options: {} }));
    expect(composer.submit).toHaveBeenCalled();
  });

  it('only attaches context when there is no prompt', async () => {
    const { glyph, composer, service } = glyphOf();

    await useGlyphContext(service, viewsOf().views, async () => [attachmentOf()]);

    expect(composer.restoreDraft).not.toHaveBeenCalled();
    expect(composer.insertAttachments).toHaveBeenCalled();
    expect(composer.focus).toHaveBeenCalled();
    expect(composer.submit).not.toHaveBeenCalled();
    expect(glyph.send).not.toHaveBeenCalled();
  });

  it('does nothing when nothing was captured', async () => {
    const { composer, service } = glyphOf();
    const { openView, views } = viewsOf();

    await useGlyphContext(service, views, async () => [], 'Fix it');

    expect(composer.insertAttachments).not.toHaveBeenCalled();
    expect(openView).not.toHaveBeenCalled();
  });

  it('refuses to attach when the chat or draft changed during capture', async () => {
    const chat = glyphOf();
    const draft = glyphOf();

    await expect(
      useGlyphContext(chat.service, viewsOf().views, async () => {
        chat.glyph.composer = composerOf();
        return [attachmentOf()];
      }),
    ).rejects.toThrow('The active draft changed during capture. Please try again.');
    await expect(
      useGlyphContext(draft.service, viewsOf().views, async () => {
        draft.composer.snapshot = { document: { parts: ['typed'] } };
        return [attachmentOf()];
      }),
    ).rejects.toThrow('The active draft changed during capture. Please try again.');
    expect(chat.composer.insertAttachments).not.toHaveBeenCalled();
    expect(draft.composer.insertAttachments).not.toHaveBeenCalled();
  });

  it('refuses to submit when the chat or draft changed while opening Chat', async () => {
    const chat = glyphOf();
    const draft = glyphOf();

    await expect(
      useGlyphContext(
        chat.service,
        viewsOf(() => {
          chat.glyph.composer = composerOf();
        }).views,
        async () => [attachmentOf()],
        'Fix it',
      ),
    ).rejects.toThrow('The active draft changed while opening Chat. Review the draft before trying again.');
    await expect(
      useGlyphContext(
        draft.service,
        viewsOf(() => {
          draft.composer.snapshot = { document: { parts: ['typed'] } };
        }).views,
        async () => [attachmentOf()],
        'Fix it',
      ),
    ).rejects.toThrow('The active draft changed while opening Chat. Review the draft before trying again.');
    expect(chat.glyph.send).not.toHaveBeenCalled();
    expect(draft.glyph.send).not.toHaveBeenCalled();
  });
});

describe(GlyphDiagnosticHover, () => {
  const hoverOf = (model: { uri: URI } | null = { uri: URI.file('/repo/a.ts') }) => {
    const { glyph, service, composer } = glyphOf();
    const markers = {
      getMarker: vi.fn((_uri: URI, decoration: IModelDecoration) =>
        decoration.id === 'marker' ? { message: 'bad' } : null,
      ),
    };
    const notifications = { error: vi.fn() };
    const { openView, views } = viewsOf();
    const editor = { getModel: () => model } as unknown as ICodeEditor;
    const hover = new GlyphDiagnosticHover(editor, markers as never, service, views, notifications as never);
    onTestFinished(() => {
      mounts.mountGlyphContextButton.mockReset();
    });
    return { hover, glyph, composer, markers, notifications, openView };
  };
  const decorationOf = (id: string) =>
    ({ id, ownerId: 0, range: new Range(1, 1, 1, 5), options: {} }) as unknown as IModelDecoration;

  it('ranks after the built-in marker hover and describes its action', () => {
    const { hover } = hoverOf();

    expect(hover.hoverOrdinal).toBe(1.1);
    expect(hover.getAccessibleContent()).toBe('Fix with Agent');
  });

  describe(GlyphDiagnosticHover.prototype.computeSync, () => {
    it('offers a part for each diagnostic under the hover', () => {
      const { hover, markers } = hoverOf();
      const anchor = new HoverRangeAnchor(0, new Range(1, 1, 1, 5), undefined, undefined);

      const parts = hover.computeSync(anchor, [decorationOf('marker'), decorationOf('other')]);

      expect(parts).toHaveLength(1);
      expect(parts[0].owner).toBe(hover);
      expect(parts[0].marker).toEqual({ message: 'bad' });
      expect(parts[0].range.equalsRange(new Range(1, 1, 1, 5))).toBe(true);
      expect(markers.getMarker).toHaveBeenCalledTimes(2);
    });

    it('offers parts for foreign hovers only when they support diagnostics', () => {
      const { hover } = hoverOf();
      const range = new Range(1, 1, 1, 5);

      expect(
        hover.computeSync(new HoverForeignElementAnchor(0, hover as never, range, undefined, undefined, true), [
          decorationOf('marker'),
        ]),
      ).toHaveLength(1);
      expect(
        hover.computeSync(new HoverForeignElementAnchor(0, hover as never, range, undefined, undefined, false), [
          decorationOf('marker'),
        ]),
      ).toEqual([]);
    });

    it('offers nothing without a model', () => {
      const { hover } = hoverOf(null);

      expect(
        hover.computeSync(new HoverRangeAnchor(0, new Range(1, 1, 1, 5), undefined, undefined), [
          decorationOf('marker'),
        ]),
      ).toEqual([]);
    });
  });

  describe(GlyphDiagnosticHover.prototype.renderHoverParts, () => {
    const contextOf = () =>
      ({ fragment: document.createDocumentFragment(), hide: vi.fn() }) as unknown as IEditorHoverRenderContext & {
        fragment: DocumentFragment;
        hide: ReturnType<typeof vi.fn>;
      };

    it('renders a button that asks the agent to fix the diagnostic', async () => {
      const { hover, glyph, composer, openView } = hoverOf();
      const context = contextOf();
      const button = buttonOf();
      const [part] = hover.computeSync(new HoverRangeAnchor(0, new Range(1, 1, 1, 5), undefined, undefined), [
        decorationOf('marker'),
      ]);

      const rendered = hover.renderHoverParts(context, [part]);
      lastButtonAction()();

      const element = rendered.renderedHoverParts[0].hoverElement;
      expect(context.fragment.firstChild).toBe(element);
      expect(element.style.padding).toBe('6px 10px');
      expect(mounts.mountGlyphContextButton).toHaveBeenCalledWith(
        element,
        'Fix with Agent',
        expect.any(Function),
        true,
      );
      expect(context.hide).toHaveBeenCalled();
      await vi.waitFor(() => expect(glyph.send).toHaveBeenCalled());
      expect(glyph.ideContext.captureDiagnostic).toHaveBeenCalledWith({ message: 'bad' });
      expect(openView).toHaveBeenCalled();
      expect(composer.restoreDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: [
            {
              type: 'text',
              text: 'Fix the attached diagnostic. Check whether it still applies to the current source before making changes.',
            },
          ],
          options: { mode: AgentModeID.AGENT },
        }),
      );
      rendered.dispose();
      expect(button.dispose).toHaveBeenCalled();
    });

    it('reports failures to fix the diagnostic', async () => {
      const { hover, glyph, notifications } = hoverOf();
      const failure = new Error('capture failed');
      glyph.ideContext.captureDiagnostic.mockRejectedValueOnce(failure);
      buttonOf();
      const [part] = hover.computeSync(new HoverRangeAnchor(0, new Range(1, 1, 1, 5), undefined, undefined), [
        decorationOf('marker'),
      ]);

      hover.renderHoverParts(contextOf(), [part]);
      lastButtonAction()();

      await vi.waitFor(() => expect(notifications.error).toHaveBeenCalledWith(failure));
    });
  });
});

describe(GlyphTerminalSelectionActions, () => {
  const terminalOf = (options: { width?: number; height?: number } = {}) => {
    const domElement = document.createElement('div');
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    Object.assign(screen.style, {
      position: 'fixed',
      left: '100px',
      top: '50px',
      width: `${options.width ?? 400}px`,
      height: `${options.height ?? 200}px`,
    });
    domElement.append(screen);
    document.body.append(domElement);
    onTestFinished(() => domElement.remove());
    const emitters = {
      selection: new Emitter<void>(),
      focus: new Emitter<void>(),
      blur: new Emitter<void>(),
      disposed: new Emitter<ITerminalInstance>(),
      scroll: new Emitter<number>(),
      resize: new Emitter<{ cols: number; rows: number }>(),
    };
    let resolveXterm!: (xterm: unknown) => void;
    const raw = {
      rows: 10,
      buffer: { active: { viewportY: 0 } },
      getSelectionPosition: vi.fn((): { start: { x: number; y: number } } | undefined => ({ start: { x: 0, y: 2 } })),
      onScroll: emitters.scroll.event,
      onResize: emitters.resize.event,
    };
    const terminal = {
      selection: 'npm ERR!' as string | undefined,
      hasFocus: true,
      domElement,
      xterm: { raw } as { raw: typeof raw } | undefined,
      onDidChangeSelection: emitters.selection.event,
      onDidFocus: emitters.focus.event,
      onDidBlur: emitters.blur.event,
      onDisposed: emitters.disposed.event,
      xtermReadyPromise: new Promise(resolve => {
        resolveXterm = resolve;
      }),
    };
    return { terminal, raw, screen, emitters, resolveXterm: (xterm: unknown = { raw }) => resolveXterm(xterm) };
  };
  const actionsOf = (instances: unknown[] = []) => {
    const created = new Emitter<ITerminalInstance>();
    const { glyph, service, composer } = glyphOf();
    const notifications = { error: vi.fn() };
    const keybindings = { lookupKeybinding: vi.fn((): { getLabel(): string | null } | undefined => undefined) };
    const actions = new GlyphTerminalSelectionActions(
      { instances, onDidCreateInstance: created.event } as unknown as ITerminalService,
      service,
      viewsOf().views,
      notifications as never,
      keybindings as never,
    );
    onTestFinished(() => {
      actions.dispose();
      mounts.mountGlyphContextButton.mockReset();
    });
    return { actions, created, glyph, composer, notifications, keybindings };
  };
  const hosts = (terminal: { domElement: HTMLElement }) => [...terminal.domElement.children].slice(1) as HTMLElement[];

  it('offers to add a focused terminal selection to Chat beside the selected row', () => {
    const { terminal, emitters } = terminalOf();
    const { keybindings } = actionsOf([terminal]);
    keybindings.lookupKeybinding.mockReturnValueOnce({ getLabel: () => '⌘L' });
    buttonOf();

    emitters.selection.fire();

    const [host] = hosts(terminal);
    expect(host.style.position).toBe('fixed');
    expect(host.style.zIndex).toBe('1000');
    expect(host.style.left).toBe('492px');
    expect(host.style.top).toBe('90px');
    expect(keybindings.lookupKeybinding).toHaveBeenCalledWith('glyph.attachTerminalSelection');
    expect(mounts.mountGlyphContextButton).toHaveBeenCalledWith(host, 'Add to Chat', expect.any(Function), false, '⌘L');
  });

  it('watches terminals created later and omits a missing shortcut', () => {
    const { terminal, emitters } = terminalOf();
    const { created, keybindings } = actionsOf();
    created.fire(terminal as unknown as ITerminalInstance);
    keybindings.lookupKeybinding.mockReturnValueOnce({ getLabel: () => null });
    buttonOf();
    buttonOf();

    emitters.focus.fire();
    emitters.focus.fire();

    expect(hosts(terminal)).toHaveLength(1);
    expect(mounts.mountGlyphContextButton.mock.calls.map(call => call[4])).toEqual([undefined, undefined]);
  });

  it('removes the button when the terminal loses focus or is disposed', () => {
    const { terminal, emitters } = terminalOf();
    actionsOf([terminal]);
    const first = buttonOf();
    const second = buttonOf();

    emitters.selection.fire();
    emitters.blur.fire();
    emitters.selection.fire();
    emitters.disposed.fire(terminal as unknown as ITerminalInstance);
    emitters.selection.fire();

    expect(first.dispose).toHaveBeenCalled();
    expect(second.dispose).toHaveBeenCalled();
    expect(hosts(terminal)).toEqual([]);
    expect(mounts.mountGlyphContextButton).toHaveBeenCalledTimes(2);
  });

  it('shows nothing without a visible focused selection', () => {
    const cases = [
      (t: ReturnType<typeof terminalOf>) => {
        t.terminal.hasFocus = false;
      },
      (t: ReturnType<typeof terminalOf>) => {
        t.terminal.selection = undefined;
      },
      (t: ReturnType<typeof terminalOf>) => {
        t.raw.getSelectionPosition.mockReturnValue(undefined);
      },
      (t: ReturnType<typeof terminalOf>) => {
        t.screen.remove();
      },
      (t: ReturnType<typeof terminalOf>) => {
        t.terminal.xterm = undefined;
      },
      (t: ReturnType<typeof terminalOf>) => {
        t.screen.style.width = '0px';
      },
      (t: ReturnType<typeof terminalOf>) => {
        t.screen.style.height = '0px';
      },
      (t: ReturnType<typeof terminalOf>) => {
        t.raw.buffer.active.viewportY = 5;
      },
      (t: ReturnType<typeof terminalOf>) => {
        t.raw.rows = 2;
      },
    ];
    for (const arrange of cases) {
      const target = terminalOf();
      actionsOf([target.terminal]);
      arrange(target);

      target.emitters.selection.fire();

      expect(hosts(target.terminal)).toEqual([]);
    }
    expect(mounts.mountGlyphContextButton).not.toHaveBeenCalled();
  });

  it('adds the selection to Chat and hides the button until the selection changes', async () => {
    const { terminal, emitters } = terminalOf();
    const { glyph, composer } = actionsOf([terminal]);
    const button = buttonOf();
    emitters.selection.fire();

    lastButtonAction()();

    await vi.waitFor(() => expect(button.dispose).toHaveBeenCalled());
    expect(glyph.ideContext.terminal).toHaveBeenCalledWith(terminal);
    expect(composer.insertAttachments).toHaveBeenCalledWith([attachmentOf('terminal.txt')]);
    expect(hosts(terminal)).toEqual([]);
    emitters.selection.fire();
    expect(hosts(terminal)).toEqual([]);
    terminal.selection = undefined;
    emitters.selection.fire();
    terminal.selection = 'npm ERR!';
    buttonOf();
    emitters.selection.fire();
    expect(hosts(terminal)).toHaveLength(1);
  });

  it('reports failures to add the selection', async () => {
    const { terminal, emitters } = terminalOf();
    const { glyph, notifications } = actionsOf([terminal]);
    const failure = new Error('read failed');
    glyph.ideContext.terminal.mockRejectedValueOnce(failure);
    buttonOf();
    emitters.selection.fire();

    lastButtonAction()();

    await vi.waitFor(() => expect(notifications.error).toHaveBeenCalledWith(failure));
    expect(hosts(terminal)).toHaveLength(1);
  });

  it('follows scrolling, resizing and layout once the terminal is ready', async () => {
    const { terminal, emitters, resolveXterm } = terminalOf();
    actionsOf([terminal]);

    resolveXterm();
    await terminal.xtermReadyPromise;
    emitters.scroll.fire(1);
    emitters.resize.fire({ cols: 80, rows: 10 });

    expect(mounts.mountGlyphContextButton.mock.calls.length).toBeGreaterThanOrEqual(2);
    const observed = mounts.mountGlyphContextButton.mock.calls.length;
    terminal.domElement.style.width = '123px';
    await vi.waitFor(() => expect(mounts.mountGlyphContextButton.mock.calls.length).toBeGreaterThan(observed));
  });

  it('ignores terminals that are disposed or have no renderer when ready', async () => {
    const disposed = terminalOf();
    const missing = terminalOf();
    actionsOf([disposed.terminal, missing.terminal]);

    disposed.emitters.disposed.fire(disposed.terminal as unknown as ITerminalInstance);
    disposed.resolveXterm();
    missing.resolveXterm(null);
    await Promise.all([disposed.terminal.xtermReadyPromise, missing.terminal.xtermReadyPromise]);
    disposed.emitters.scroll.fire(1);
    missing.emitters.scroll.fire(1);

    expect(mounts.mountGlyphContextButton).not.toHaveBeenCalled();
  });
});
