import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Emitter } from '#vs/base/common/event.js';
import { URI } from '#vs/base/common/uri.js';
import { BrowserViewCommandId } from '#vs/platform/browserView/common/browserView.js';
import { IModelService } from '#vs/editor/common/services/model.js';
import { ILanguageService } from '#vs/editor/common/languages/language.js';
import { Parts } from '#vs/workbench/services/layout/browser/layoutService.js';
import { ViewContainerLocation } from '#vs/workbench/common/views.js';
import type { GlyphWorkbenchViewActions } from '#glyph/workbench/GlyphWorkbenchView.js';
import type { GlyphWorkbenchState } from '#glyph/workbench/GlyphWorkbenchState.js';
import { GlyphViewPane } from '#vs/workbench/contrib/glyph/browser/GlyphViewPane.js';

const mounts = vi.hoisted(() => ({ mountGlyphWorkbench: vi.fn() }));
vi.mock('#code-oss/ui/mountGlyphWorkbench.tsx', () => mounts);
vi.mock('#vs/workbench/browser/parts/views/viewPane.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  ViewPane: (await import('./support/ViewPaneStub.ts')).ViewPaneStub,
}));

const glyphServiceOf = () => {
  const stateChanged = new Emitter<GlyphWorkbenchState>();
  const methods = [
    'connect',
    'moveQueuedToNewChat',
    'sendImmediately',
    'steer',
    'send',
    'branchChat',
    'restoreCheckpoint',
    'openLink',
    'copyText',
    'viewPlan',
    'selectMode',
    'buildPlan',
    'cancel',
    'writeShellInput',
    'openShell',
    'stopShell',
    'answerQuestion',
    'decideApproval',
    'reviewProposalFile',
    'decideProposalItems',
    'newChat',
    'closeChat',
    'setChatArchived',
    'setChatPinned',
    'openChat',
    'selectAccount',
    'selectModel',
  ] as const;
  return {
    ...(Object.fromEntries(methods.map(method => [method, vi.fn(async () => method)])) as Record<
      (typeof methods)[number],
      ReturnType<typeof vi.fn>
    >),
    state: { chats: [], selectedChatId: undefined, transcript: [] } as unknown as GlyphWorkbenchState,
    composer: { id: 'composer' },
    context: { id: 'context' },
    followUpBehavior: 'queue',
    onDidChangeState: stateChanged.event,
    stateChanged,
  };
};

const paneOf = () => {
  const keybindingsUpdated = new Emitter<void>();
  const sizes = new Map<Parts, { width: number; height: number }>();
  const services = {
    dialogs: { showSaveDialog: vi.fn(async (): Promise<URI | undefined> => URI.file('/out/chat.md')) },
    files: { writeFile: vi.fn(async () => ({})) },
    commands: { executeCommand: vi.fn(async () => undefined) },
    keybindings: {
      onDidUpdateKeybindings: keybindingsUpdated.event,
      lookupKeybinding: vi.fn((): { getLabel(): string | null } | undefined => undefined),
      dispatchEvent: vi.fn(() => false),
    },
    contextKeys: { createScoped: vi.fn() },
    viewDescriptors: { getViewLocationById: vi.fn(() => ViewContainerLocation.AuxiliaryBar) },
    instantiation: {
      invokeFunction: vi.fn(<T>(fn: (accessor: { get(id: unknown): unknown }) => T) =>
        fn({
          get: id =>
            id === IModelService
              ? { getModel: () => null }
              : id === ILanguageService
                ? { guessLanguageIdByFilepathOrFirstLine: () => 'typescript' }
                : undefined,
        }),
      ),
    },
    layout: {
      getSize: vi.fn((part: Parts) => ({ ...(sizes.get(part) ?? { width: 300, height: 600 }) })),
      setSize: vi.fn((part: Parts, size: { width: number; height: number }) =>
        sizes.set(part, { ...size, width: Math.min(size.width, 400) }),
      ),
      toggleMaximizedAuxiliaryBar: vi.fn(),
      setPartHidden: vi.fn(),
    },
    preferences: { openSettings: vi.fn(async () => undefined) },
    glyph: glyphServiceOf(),
  };
  const pane = new GlyphViewPane(
    { id: GlyphViewPane.ID, title: 'Chat' } as never,
    services.dialogs as never,
    services.files as never,
    services.commands as never,
    services.keybindings as never,
    {} as never,
    {} as never,
    services.contextKeys as never,
    services.viewDescriptors as never,
    services.instantiation as never,
    {} as never,
    {} as never,
    {} as never,
    services.layout as never,
    services.preferences as never,
    services.glyph as never,
  );
  onTestFinished(() => {
    pane.dispose();
    mounts.mountGlyphWorkbench.mockReset();
  });
  const render = () => {
    const view = { update: vi.fn(), dispose: vi.fn() };
    mounts.mountGlyphWorkbench.mockReturnValueOnce(view);
    const container = document.createElement('div');
    (pane as unknown as { renderBody(container: HTMLElement): void }).renderBody(container);
    const actions = mounts.mountGlyphWorkbench.mock.lastCall![2] as GlyphWorkbenchViewActions;
    return { view, container, actions };
  };
  return { pane, services, render, keybindingsUpdated };
};

const menuOf = (actions: GlyphWorkbenchViewActions) =>
  Object.fromEntries(
    (
      actions as unknown as { chatMenuActions: { id: string; label: string; run(): Promise<void> | void }[] }
    ).chatMenuActions.map(action => [action.id, action]),
  );

describe(GlyphViewPane, () => {
  it('mounts the workbench with the current state', () => {
    const { pane, services, render } = paneOf();

    const { container, actions } = render();

    expect(mounts.mountGlyphWorkbench).toHaveBeenCalledWith(container, services.glyph.state, expect.any(Object));
    expect((pane as unknown as { renderedBodies: HTMLElement[] }).renderedBodies).toEqual([container]);
    expect(actions.composer).toBe(services.glyph.composer);
    expect(actions.context).toBe(services.glyph.context);
    expect(actions.followUpBehavior).toBe('queue');
    expect(actions.managesQueue).toBe(true);
  });

  it('replaces the workbench when its body is rendered again', () => {
    const { render } = paneOf();

    const first = render();
    render();

    expect(first.view.dispose).toHaveBeenCalled();
  });

  it('refreshes the workbench when the state or keybindings change', () => {
    const { services, render, keybindingsUpdated } = paneOf();
    services.glyph.stateChanged.fire(services.glyph.state);
    keybindingsUpdated.fire();
    const { view } = render();
    const next = { ...services.glyph.state, selectedChatId: 'chat-2' } as GlyphWorkbenchState;

    services.glyph.stateChanged.fire(next);
    keybindingsUpdated.fire();

    expect(view.update.mock.calls).toEqual([[next], [services.glyph.state]]);
  });

  it('resolves composer keybindings through the workbench', () => {
    const { services, render } = paneOf();
    const { actions } = render();
    services.keybindings.lookupKeybinding.mockReturnValueOnce({ getLabel: () => '⌘↵' });
    services.keybindings.lookupKeybinding.mockReturnValueOnce({ getLabel: () => null });

    expect(actions.composerKeybindings!.label('glyph.composer.submit' as never)).toBe('⌘↵');
    expect(actions.composerKeybindings!.label('glyph.composer.submit' as never)).toBeUndefined();
    expect(actions.composerKeybindings!.label('glyph.composer.submit' as never)).toBeUndefined();
  });

  it('scopes the composer focus context to its element', () => {
    const { services, render } = paneOf();
    const { actions } = render();
    const scope = { createKey: vi.fn(), dispose: vi.fn() };
    services.contextKeys.createScoped.mockReturnValue(scope);
    const element = document.createElement('div');

    const release = actions.composerKeybindings!.mount(element);
    release();

    expect(services.contextKeys.createScoped).toHaveBeenCalledWith(element);
    expect(scope.createKey).toHaveBeenCalledWith('glyph.composerFocus', true);
    expect(scope.dispose).toHaveBeenCalled();
  });

  it('stops composer key events that the workbench handles', () => {
    const { services, render } = paneOf();
    const { actions } = render();
    const target = document.createElement('textarea');
    const handled = new KeyboardEvent('keydown', { key: 'Enter' });
    const ignored = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(handled, 'target', { value: target });
    const stop = vi.spyOn(handled, 'stopPropagation');
    const stopIgnored = vi.spyOn(ignored, 'stopPropagation');
    services.keybindings.dispatchEvent.mockReturnValueOnce(true);

    expect(actions.composerKeybindings!.dispatch(handled)).toBe(true);
    expect(actions.composerKeybindings!.dispatch(ignored)).toBe(false);
    expect(services.keybindings.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ browserEvent: handled }),
      target,
    );
    expect(stop).toHaveBeenCalled();
    expect(stopIgnored).not.toHaveBeenCalled();
  });

  it('widens the part that hosts the chat for history and releases only the width it added', () => {
    for (const [location, part] of [
      [ViewContainerLocation.Sidebar, Parts.SIDEBAR_PART],
      [ViewContainerLocation.Panel, Parts.PANEL_PART],
      [ViewContainerLocation.AuxiliaryBar, Parts.AUXILIARYBAR_PART],
    ] as const) {
      const { services, render } = paneOf();
      const { actions } = render();
      services.viewDescriptors.getViewLocationById.mockReturnValue(location);

      const release = actions.reserveHistoryWidth!(200);
      release();

      expect(services.viewDescriptors.getViewLocationById).toHaveBeenCalledWith(GlyphViewPane.ID);
      expect(services.layout.setSize.mock.calls).toEqual([
        [part, { width: 500, height: 600 }],
        [part, { width: 300, height: 600 }],
      ]);
    }
  });

  it('forwards chat interactions to the workbench service', async () => {
    const { services, render } = paneOf();
    const { actions } = render();
    const calls: [keyof typeof services.glyph & keyof GlyphWorkbenchViewActions, unknown[]][] = [
      ['moveQueuedToNewChat', ['queued-1']],
      ['sendImmediately', ['now', [], { mode: 'agent' }]],
      ['steer', ['steer', [], {}]],
      ['send', ['hello', [], {}]],
      ['branchChat', ['chat-1', 'turn-1']],
      ['restoreCheckpoint', ['chat-1', 'turn-1']],
      ['openLink', ['https://example.com']],
      ['copyText', ['copied']],
      ['viewPlan', ['chat-1', { id: 'plan-1' }]],
      ['selectMode', ['plan']],
      ['buildPlan', ['chat-1', { id: 'plan-1' }, true]],
      ['cancel', []],
      ['writeShellInput', ['chat-1', 'session-1', 'ls', true]],
      ['openShell', ['chat-1', 'session-1']],
      ['stopShell', ['chat-1', 'session-1']],
      ['answerQuestion', ['chat-1', 'run-1', 'question-1', 'yes']],
      ['decideApproval', ['chat-1', 'run-1', 'approval-1', 'approve']],
      ['reviewProposalFile', ['chat-1', 'proposal-1', 'file-1']],
      ['decideProposalItems', ['chat-1', [{ proposalId: 'proposal-1', itemId: 'item-1' }], true]],
      ['newChat', []],
      ['closeChat', ['chat-1']],
      ['setChatArchived', ['chat-1', true]],
      ['setChatPinned', ['chat-1', true]],
      ['openChat', ['chat-1']],
      ['selectAccount', ['openai', 'account-1']],
      ['selectModel', ['gpt']],
    ];

    for (const [method, args] of calls) {
      await expect((actions[method] as (...args: unknown[]) => unknown)(...args)).resolves.toBe(method);
      expect(services.glyph[method]).toHaveBeenCalledWith(...args);
    }
    await actions.reconnectWorkspace!();
    expect(services.glyph.connect).toHaveBeenCalled();
  });

  it('opens the message settings', () => {
    const { services, render } = paneOf();
    const { actions } = render();

    actions.openMessageSettings!();

    expect(services.preferences.openSettings).toHaveBeenCalledWith({ query: 'glyph.chat.followUpBehavior' });
  });

  it('resolves file icons through the workbench language service', () => {
    const { render } = paneOf();
    const { actions } = render();

    expect(actions.fileIconClasses!('/repo/src/main.ts')).toEqual(
      expect.arrayContaining(['file-icon', 'main.ts-name-file-icon', 'typescript-lang-file-icon']),
    );
  });

  it('exports the selected transcript as Markdown', async () => {
    const { services, render } = paneOf();
    const { actions } = render();
    services.glyph.state = {
      chats: [{ id: 'chat-1', title: 'Fix bug' }],
      selectedChatId: 'chat-1',
      transcript: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello' },
      ],
    } as unknown as GlyphWorkbenchState;

    await menuOf(actions).export.run();

    expect(menuOf(actions).export.label).toBe('Export Transcript');
    expect(services.dialogs.showSaveDialog).toHaveBeenCalledWith({
      title: 'Export Glyph transcript',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    const [resource, buffer] = services.files.writeFile.mock.calls[0] as unknown as [URI, { toString(): string }];
    expect(resource.toString()).toBe(URI.file('/out/chat.md').toString());
    expect(buffer.toString()).toBe('# Fix bug\n\n## user\n\nHi\n\n## assistant\n\nHello\n');
  });

  it('exports an untitled chat under a default title', async () => {
    const { services, render } = paneOf();
    const { actions } = render();

    await menuOf(actions).export.run();

    const [, buffer] = services.files.writeFile.mock.calls[0] as unknown as [URI, { toString(): string }];
    expect(buffer.toString()).toBe('# New chat\n\n\n');
  });

  it('writes nothing when the export is cancelled', async () => {
    const { services, render } = paneOf();
    const { actions } = render();
    services.dialogs.showSaveDialog.mockResolvedValueOnce(undefined);

    await menuOf(actions).export.run();

    expect(services.files.writeFile).not.toHaveBeenCalled();
  });

  it('opens the browser, settings and layout controls', async () => {
    const { services, render } = paneOf();
    const { actions } = render();
    const menu = menuOf(actions);

    await menu.browser.run();
    await expect(menu.settings.run()).resolves.toBeUndefined();
    menu.maximize.run();
    menu.hide.run();

    expect(services.commands.executeCommand).toHaveBeenCalledWith(BrowserViewCommandId.Open);
    expect(services.preferences.openSettings).toHaveBeenCalledWith({ query: 'glyph' });
    expect(services.layout.toggleMaximizedAuxiliaryBar).toHaveBeenCalled();
    expect(services.layout.setPartHidden).toHaveBeenCalledWith(true, Parts.AUXILIARYBAR_PART);
    expect(Object.values(menu).map(action => action.label)).toEqual([
      'Export Transcript',
      'Open Browser',
      'Agent Settings',
      'Toggle Maximized Chat',
      'Hide Chat',
    ]);
  });
});
