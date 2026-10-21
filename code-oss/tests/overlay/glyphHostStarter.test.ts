import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphTransportMessageType } from '#glyph/protocol/connection/GlyphTransportMessage.js';
import { GlyphHostStarter } from '#vs/platform/glyph/electron-main/glyphHostStarter.js';

const electronMain = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const processes: FakeUtilityProcess[] = [];
  const behavior: { start: boolean; connect: (payload: unknown) => { close: () => void } } = {
    start: true,
    connect: () => ({ close: () => {} }),
  };
  class FakeUtilityProcess {
    readonly exitListeners = new Set<() => void>();
    readonly stderrListeners = new Set<(data: string) => void>();
    readonly configurations: unknown[] = [];
    readonly payloads: unknown[] = [];
    killed = false;
    disposed = false;
    constructor(...args: unknown[]) {
      this.args = args;
      processes.push(this);
    }
    readonly args: unknown[];
    start(configuration: unknown): boolean {
      this.configurations.push(configuration);
      return behavior.start;
    }
    connect(payload: unknown) {
      this.payloads.push(payload);
      return behavior.connect(payload);
    }
    onExit(listener: () => void) {
      this.exitListeners.add(listener);
      return { dispose: () => this.exitListeners.delete(listener) };
    }
    onStderr(listener: (data: string) => void) {
      this.stderrListeners.add(listener);
      return { dispose: () => this.stderrListeners.delete(listener) };
    }
    exit(): void {
      for (const listener of [...this.exitListeners]) listener();
    }
    writeStderr(data: string): void {
      for (const listener of this.stderrListeners) listener(data);
    }
    kill(): void {
      this.killed = true;
    }
    dispose(): void {
      this.disposed = true;
    }
  }
  return {
    listeners,
    processes,
    behavior,
    FakeUtilityProcess,
    emit(channel: string, ...args: unknown[]) {
      for (const listener of listeners.get(channel) ?? []) listener(...args);
    },
  };
});

vi.mock('electron', () => ({ default: {} }));
vi.mock('#vs/base/parts/ipc/electron-main/ipcMain.js', () => ({
  validatedIpcMain: {
    on(channel: string, listener: (...args: unknown[]) => void) {
      if (!electronMain.listeners.has(channel)) electronMain.listeners.set(channel, new Set());
      electronMain.listeners.get(channel)!.add(listener);
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void) {
      electronMain.listeners.get(channel)?.delete(listener);
    },
  },
}));
vi.mock('#vs/platform/utilityProcess/electron-main/utilityProcess.js', () => ({
  UtilityProcess: electronMain.FakeUtilityProcess,
}));
vi.mock('#vs/platform/environment/electron-main/environmentMainService.js', () => ({
  IEnvironmentMainService: () => {},
}));
vi.mock('#vs/platform/lifecycle/electron-main/lifecycleMainService.js', () => ({
  ILifecycleMainService: () => {},
}));
vi.mock('#vs/platform/windows/electron-main/windows.js', () => ({ IWindowsMainService: () => {} }));

const requestChannel = 'vscode:glyph:createHostMessageChannel';
const responseChannel = 'vscode:glyph:createHostMessageChannelResult';
const preserveChannel = 'vscode:glyph:preserveWorkspaceHistory';

interface FakeWindow {
  id: number;
  openedWorkspace?: { id: string };
  profile?: { id: string };
}

function sender(id: number, destroyed: () => boolean = () => false) {
  const once = new Map<string, () => void>();
  return {
    id,
    isDestroyed: vi.fn(destroyed),
    send: vi.fn(),
    postMessage: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => once.set(event, listener)),
    destroy: () => once.get('destroyed')?.(),
  };
}

function starter({
  windows = new Map<unknown, FakeWindow>(),
  isBuilt = false,
  state = new Map<string, string>(),
}: {
  windows?: Map<unknown, FakeWindow>;
  isBuilt?: boolean;
  state?: Map<string, string>;
} = {}) {
  electronMain.processes.length = 0;
  electronMain.behavior.start = true;
  electronMain.behavior.connect = () => ({ close: () => {} });
  const stateService = {
    getItem: vi.fn((key: string) => state.get(key)),
    setItem: vi.fn((key: string, value: string) => state.set(key, value)),
  };
  const environmentMainService = { isBuilt, appRoot: '/app/root' };
  const lifecycleMainService = {};
  const logService = { info: vi.fn(), error: vi.fn() };
  const windowsMainService = { getWindowByWebContents: vi.fn((contents: unknown) => windows.get(contents)) };
  const instance = new GlyphHostStarter(
    stateService as never,
    environmentMainService as never,
    lifecycleMainService as never,
    logService as never,
    windowsMainService as never,
  );
  onTestFinished(() => instance.dispose());
  return { instance, stateService, logService, windows, state, lifecycleMainService };
}

async function request(event: { sender: ReturnType<typeof sender> }, nonce: unknown): Promise<void> {
  electronMain.emit(requestChannel, event, nonce);
  await Promise.resolve();
}

describe(GlyphHostStarter, () => {
  it('ignores requests without a textual nonce or from destroyed windows', async () => {
    const { logService } = starter();
    const alive = sender(1);
    const destroyed = sender(2, () => true);

    await request({ sender: alive }, 42);
    await request({ sender: destroyed }, 'nonce');

    expect(alive.send).not.toHaveBeenCalled();
    expect(destroyed.send).not.toHaveBeenCalled();
    expect(logService.info).not.toHaveBeenCalled();
    expect(electronMain.processes).toHaveLength(0);
  });

  it('rejects requests from unregistered windows', async () => {
    starter();
    const contents = sender(1);

    await request({ sender: contents }, 'nonce');

    expect(contents.send).toHaveBeenCalledWith(responseChannel, {
      nonce: 'nonce',
      error: 'The requesting Glyph window is not registered.',
    });
  });

  it('starts the source-tree host once and transfers a port to each window', async () => {
    const first = sender(1);
    const second = sender(2);
    const windows = new Map<unknown, FakeWindow>([
      [first, { id: 7, openedWorkspace: { id: 'workspace' }, profile: { id: 'work' } }],
      [second, { id: 8 }],
    ]);
    const { logService, lifecycleMainService } = starter({ windows });
    const ports = [{ close: vi.fn() }, { close: vi.fn() }];
    electronMain.behavior.connect = () => ports[electronMain.processes[0]!.payloads.length - 1]!;

    await request({ sender: first }, 'first');
    await request({ sender: second }, 'second');

    expect(electronMain.processes).toHaveLength(1);
    const [utilityProcess] = electronMain.processes;
    expect(utilityProcess!.args).toEqual([logService, expect.anything(), lifecycleMainService]);
    expect(utilityProcess!.configurations).toEqual([
      {
        type: 'glyphHost',
        name: 'glyph-host',
        entryPoint: 'vs/platform/glyph/node/glyphHostBootstrap',
        env: expect.objectContaining({
          GLYPH_DESKTOP_HOST_ENTRY: '/.artifacts/glyph-desktop-host/dist/desktop/host/utilityMain.js',
        }),
      },
    ]);
    expect(utilityProcess!.payloads).toEqual([
      {
        type: GlyphTransportMessageType.CONNECTION,
        connectionId: expect.any(String),
        identity: { profileId: 'work', windowId: '7', workspaceId: 'workspace' },
      },
      {
        type: GlyphTransportMessageType.CONNECTION,
        connectionId: expect.any(String),
        identity: { profileId: 'default', windowId: '8', workspaceId: 'empty:8' },
      },
    ]);
    expect(first.postMessage).toHaveBeenCalledWith(responseChannel, 'first', [ports[0]]);
    expect(second.postMessage).toHaveBeenCalledWith(responseChannel, 'second', [ports[1]]);
    expect(logService.info).toHaveBeenCalledWith(
      '[Glyph host] utility process started from /.artifacts/glyph-desktop-host/dist/desktop/host/utilityMain.js',
    );
  });

  it('starts the packaged host artifact in built applications', async () => {
    const contents = sender(1);
    starter({ windows: new Map([[contents, { id: 1 }]]), isBuilt: true });

    await request({ sender: contents }, 'nonce');

    expect(electronMain.processes[0]!.configurations).toEqual([
      expect.objectContaining({
        env: expect.objectContaining({
          GLYPH_DESKTOP_HOST_ENTRY: '/app/root/glyph/dist/desktop/host/utilityMain.js',
        }),
      }),
    ]);
  });

  it('continues a workspace conversation history that was preserved for the window', async () => {
    const contents = sender(1);
    const state = new Map([['glyph.historyWorkspace.default.empty:3', 'previous-workspace']]);
    starter({ windows: new Map([[contents, { id: 3 }]]), state });

    await request({ sender: contents }, 'nonce');

    expect(electronMain.processes[0]!.payloads).toEqual([
      expect.objectContaining({
        identity: { profileId: 'default', windowId: '3', workspaceId: 'previous-workspace' },
      }),
    ]);
  });

  it('reports a host that does not start', async () => {
    const contents = sender(1);
    starter({ windows: new Map([[contents, { id: 1 }]]) });
    electronMain.behavior.start = false;

    await request({ sender: contents }, 'nonce');

    expect(electronMain.processes[0]!.disposed).toBe(true);
    expect(contents.send).toHaveBeenCalledWith(responseChannel, {
      nonce: 'nonce',
      error: 'The Glyph utility process did not start.',
    });
  });

  it('reports failures that are not errors', async () => {
    const contents = sender(1);
    starter({ windows: new Map([[contents, { id: 1 }]]) });
    electronMain.behavior.connect = () => {
      throw 'port unavailable';
    };

    await request({ sender: contents }, 'nonce');

    expect(contents.send).toHaveBeenCalledWith(responseChannel, { nonce: 'nonce', error: 'port unavailable' });
  });

  it('does not report failures to a window destroyed in the meantime', async () => {
    let destroyed = false;
    const contents = sender(1, () => destroyed);
    starter({ windows: new Map([[contents, { id: 1 }]]) });
    electronMain.behavior.connect = () => {
      destroyed = true;
      throw new Error('port unavailable');
    };

    await request({ sender: contents }, 'nonce');

    expect(contents.send).not.toHaveBeenCalled();
  });

  it('closes the port when the window is destroyed during connection', async () => {
    let destroyed = false;
    const contents = sender(1, () => destroyed);
    starter({ windows: new Map([[contents, { id: 1 }]]) });
    const port = { close: vi.fn() };
    electronMain.behavior.connect = () => {
      destroyed = true;
      return port;
    };

    await request({ sender: contents }, 'nonce');

    expect(port.close).toHaveBeenCalled();
    expect(contents.postMessage).not.toHaveBeenCalled();
  });

  it('notifies live connected windows once the host exits and restarts it on demand', async () => {
    const live = sender(1);
    let destroyed = false;
    const gone = sender(2, () => destroyed);
    starter({
      windows: new Map<unknown, FakeWindow>([
        [live, { id: 1 }],
        [gone, { id: 2 }],
      ]),
    });
    await request({ sender: live }, 'first');
    await request({ sender: live }, 'again');
    await request({ sender: gone }, 'second');
    destroyed = true;
    const [original] = electronMain.processes;

    original!.exit();
    await request({ sender: live }, 'third');
    original!.exit();

    expect(live.send.mock.calls).toEqual([['vscode:glyph:hostExited'], ['vscode:glyph:hostExited']]);
    expect(gone.send).not.toHaveBeenCalled();
    expect(live.once).toHaveBeenCalledTimes(1);
    expect(electronMain.processes).toHaveLength(2);
  });

  it('stops notifying windows after they are destroyed', async () => {
    const contents = sender(1);
    starter({ windows: new Map([[contents, { id: 1 }]]) });
    await request({ sender: contents }, 'nonce');

    contents.destroy();
    electronMain.processes[0]!.exit();

    expect(contents.send).not.toHaveBeenCalled();
  });

  it('logs host diagnostics', async () => {
    const contents = sender(1);
    const { logService } = starter({ windows: new Map([[contents, { id: 1 }]]) });
    await request({ sender: contents }, 'nonce');

    electronMain.processes[0]!.writeStderr('boom');

    expect(logService.error).toHaveBeenCalledWith('[Glyph host] boom');
  });

  it('stops the host and its IPC listeners once disposed', async () => {
    const contents = sender(1);
    const { instance } = starter({ windows: new Map([[contents, { id: 1 }]]) });
    await request({ sender: contents }, 'nonce');

    instance.dispose();
    await request({ sender: contents }, 'later');

    expect(electronMain.processes[0]!.killed).toBe(true);
    expect(electronMain.processes[0]!.disposed).toBe(true);
    expect(electronMain.processes).toHaveLength(1);
    expect(electronMain.listeners.get(requestChannel)?.size).toBe(0);
    expect(electronMain.listeners.get(preserveChannel)?.size).toBe(0);
  });

  it('preserves the conversation history of a window that opens another workspace', async () => {
    const contents = sender(1);
    const window: FakeWindow = { id: 1, openedWorkspace: { id: 'before' }, profile: { id: 'work' } };
    const { stateService, state } = starter({ windows: new Map([[contents, window]]) });
    await request({ sender: contents }, 'nonce');
    window.openedWorkspace = { id: 'after' };

    electronMain.emit(preserveChannel, { sender: contents });
    state.set('glyph.historyWorkspace.work.after', 'unchanged');
    electronMain.emit(preserveChannel, { sender: contents });

    expect(stateService.setItem.mock.calls).toEqual([['glyph.historyWorkspace.work.after', 'before']]);
    expect(state.get('glyph.historyWorkspace.work.after')).toBe('unchanged');
  });

  it('preserves the history of the default profile', async () => {
    const contents = sender(1);
    const window: FakeWindow = { id: 1 };
    const { stateService } = starter({ windows: new Map([[contents, window]]) });
    await request({ sender: contents }, 'nonce');
    window.openedWorkspace = { id: 'opened' };

    electronMain.emit(preserveChannel, { sender: contents });

    expect(stateService.setItem).toHaveBeenCalledWith('glyph.historyWorkspace.default.opened', 'empty:1');
  });

  it('does not preserve history without a known window, workspace, connection or matching profile', async () => {
    const contents = sender(1);
    const unknown = sender(2);
    const unconnected = sender(3);
    const window: FakeWindow = { id: 1, profile: { id: 'work' } };
    const { stateService } = starter({
      windows: new Map<unknown, FakeWindow>([
        [contents, window],
        [unconnected, { id: 3, openedWorkspace: { id: 'workspace' } }],
      ]),
    });
    await request({ sender: contents }, 'nonce');

    electronMain.emit(preserveChannel, { sender: unknown });
    electronMain.emit(preserveChannel, { sender: unconnected });
    electronMain.emit(preserveChannel, { sender: contents });
    window.openedWorkspace = { id: 'opened' };
    window.profile = { id: 'other' };
    electronMain.emit(preserveChannel, { sender: contents });
    delete window.profile;
    electronMain.emit(preserveChannel, { sender: contents });

    expect(stateService.setItem).not.toHaveBeenCalled();
  });

  it('forgets the history of destroyed windows', async () => {
    const contents = sender(1);
    const window: FakeWindow = { id: 1 };
    const { stateService } = starter({ windows: new Map([[contents, window]]) });
    await request({ sender: contents }, 'nonce');
    contents.destroy();
    window.openedWorkspace = { id: 'opened' };

    electronMain.emit(preserveChannel, { sender: contents });

    expect(stateService.setItem).not.toHaveBeenCalled();
  });
});
