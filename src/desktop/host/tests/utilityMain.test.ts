import { EventEmitter } from 'node:events';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { GlyphTransportMessageType } from '#src/desktop/protocol/connection/GlyphTransportMessage.js';

function messagePort() {
  return Object.assign(new EventEmitter(), { postMessage: vi.fn(), start: vi.fn(), close: vi.fn() });
}

function startUtilityHost(options: { parentPort?: boolean; environment?: Record<string, string> } = {}) {
  vi.resetModules();
  const parent = new EventEmitter();
  const host = {
    constructed: vi.fn(),
    connect: vi.fn(),
    receive: vi.fn(async (_connectionId: string, _envelope: unknown) => {}),
    disconnect: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const editors = { constructed: vi.fn(), connect: vi.fn(), receive: vi.fn(), disconnect: vi.fn() };
  const openai = { constructed: vi.fn(), dispose: vi.fn(async () => {}) };
  const deterministic = { constructed: vi.fn() };
  const scripted = { constructed: vi.fn(), fetch: vi.fn() };
  vi.doMock('#src/desktop/host/GlyphDesktopHost.js', () => ({
    GlyphDesktopHost: class {
      readonly generation = 'generation';
      constructor(factory: unknown) {
        host.constructed(factory);
      }
      connect(...arguments_: unknown[]) {
        return host.connect(...arguments_);
      }
      receive(connectionId: string, envelope: unknown) {
        return host.receive(connectionId, envelope);
      }
      disconnect() {
        return host.disconnect();
      }
      dispose() {
        return host.dispose();
      }
    },
  }));
  vi.doMock('#src/desktop/workspace/EditorRpcRouter.js', () => ({
    EditorRpcRouter: class {
      constructor() {
        editors.constructed(this);
      }
      connect(...arguments_: unknown[]) {
        return editors.connect(...arguments_);
      }
      receive(...arguments_: unknown[]) {
        return editors.receive(...arguments_);
      }
      disconnect(...arguments_: unknown[]) {
        return editors.disconnect(...arguments_);
      }
    },
  }));
  vi.doMock('#src/desktop/host/OpenAIDesktopRuntimeFactory.js', () => ({
    OpenAIDesktopRuntimeFactory: class {
      constructor(...arguments_: unknown[]) {
        openai.constructed(this, ...arguments_);
      }
      dispose() {
        return openai.dispose();
      }
    },
  }));
  vi.doMock('#src/desktop/host/DeterministicDesktopRuntime.js', () => ({
    DeterministicDesktopRuntimeFactory: class {
      constructor() {
        deterministic.constructed(this);
      }
    },
  }));
  vi.doMock('#src/desktop/host/ScriptedDesktopTransport.js', () => ({
    ScriptedDesktopTransport: class {
      readonly fetch = scripted.fetch;
      constructor(endpoint: string) {
        scripted.constructed(endpoint);
      }
    },
  }));
  vi.stubEnv('GLYPH_DESKTOP_TEST_RUNTIME', undefined);
  vi.stubEnv('GLYPH_DESKTOP_TEST_PROVIDER_URL', undefined);
  for (const [name, value] of Object.entries(options.environment ?? {})) vi.stubEnv(name, value);
  if (options.parentPort !== false)
    Object.defineProperty(process, 'parentPort', { value: parent, configurable: true, writable: true });
  const once = vi.spyOn(process, 'once').mockReturnValue(process);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  onTestFinished(() => {
    Reflect.deleteProperty(process, 'parentPort');
    once.mockRestore();
    exit.mockRestore();
    vi.unstubAllEnvs();
    for (const path of [
      '#src/desktop/host/GlyphDesktopHost.js',
      '#src/desktop/workspace/EditorRpcRouter.js',
      '#src/desktop/host/OpenAIDesktopRuntimeFactory.js',
      '#src/desktop/host/DeterministicDesktopRuntime.js',
      '#src/desktop/host/ScriptedDesktopTransport.js',
    ])
      vi.doUnmock(path);
    vi.resetModules();
  });
  const loaded = import('#src/desktop/host/utilityMain.js');
  const signal = (name: string) => {
    const handler = once.mock.calls.find(([event]) => event === name)?.[1] as (() => void) | undefined;
    if (!handler) throw new Error(`No ${name} handler was registered.`);
    handler();
  };
  return { loaded, parent, host, editors, openai, deterministic, scripted, exit, signal };
}

const identity = { profileId: 'profile', windowId: 'window', workspaceId: 'workspace' };

describe('utilityMain', () => {
  it('refuses to start outside an Electron utility process', async () => {
    const { loaded } = startUtilityHost({ parentPort: false });
    await expect(loaded).rejects.toThrow('The Glyph desktop host must run as an Electron utility process.');
  });

  it('serves workspaces through the OpenAI runtime by default', async () => {
    const { loaded, host, editors, openai, scripted, deterministic } = startUtilityHost();
    await loaded;
    const router = editors.constructed.mock.calls[0]?.[0];
    const factory = openai.constructed.mock.calls[0]?.[0];
    expect(openai.constructed).toHaveBeenCalledExactlyOnceWith(factory, router, undefined);
    expect(host.constructed).toHaveBeenCalledExactlyOnceWith(factory);
    expect(scripted.constructed).not.toHaveBeenCalled();
    expect(deterministic.constructed).not.toHaveBeenCalled();
  });

  it('routes provider traffic through the scripted fixture when selected', async () => {
    const { loaded, openai, scripted } = startUtilityHost({
      environment: { GLYPH_DESKTOP_TEST_RUNTIME: 'scripted', GLYPH_DESKTOP_TEST_PROVIDER_URL: 'http://127.0.0.1:9' },
    });
    await loaded;
    expect(scripted.constructed).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:9');
    expect(openai.constructed.mock.calls[0]?.[2]).toBe(scripted.fetch);
  });

  it('passes an empty endpoint to the scripted fixture when none is configured', async () => {
    const { loaded, scripted } = startUtilityHost({ environment: { GLYPH_DESKTOP_TEST_RUNTIME: 'scripted' } });
    await loaded;
    expect(scripted.constructed).toHaveBeenCalledExactlyOnceWith('');
  });

  it('serves workspaces through the deterministic runtime when selected', async () => {
    const { loaded, host, deterministic, openai } = startUtilityHost({
      environment: { GLYPH_DESKTOP_TEST_RUNTIME: 'deterministic' },
    });
    await loaded;
    const factory = deterministic.constructed.mock.calls[0]?.[0];
    expect(factory).toBeDefined();
    expect(host.constructed).toHaveBeenCalledExactlyOnceWith(factory);
    expect(openai.constructed).toHaveBeenCalledOnce();
  });

  it.each([
    ['no payload', undefined],
    ['another message type', { type: GlyphTransportMessageType.READY, connectionId: 'c', identity }],
    ['no connection id', { type: GlyphTransportMessageType.CONNECTION, identity }],
    ['no identity', { type: GlyphTransportMessageType.CONNECTION, connectionId: 'c' }],
    ['a non-object identity', { type: GlyphTransportMessageType.CONNECTION, connectionId: 'c', identity: 'window' }],
    [
      'an identity without a profile',
      { type: GlyphTransportMessageType.CONNECTION, connectionId: 'c', identity: { ...identity, profileId: 1 } },
    ],
    [
      'an identity without a window',
      { type: GlyphTransportMessageType.CONNECTION, connectionId: 'c', identity: { ...identity, windowId: null } },
    ],
    [
      'an identity without a workspace',
      { type: GlyphTransportMessageType.CONNECTION, connectionId: 'c', identity: { ...identity, workspaceId: [] } },
    ],
  ])('closes a connection offer with %s', async (_label, data) => {
    const { loaded, parent, host, editors } = startUtilityHost();
    await loaded;
    const port = messagePort();
    parent.emit('message', { data, ports: [port] });
    expect(port.close).toHaveBeenCalledOnce();
    expect(port.start).not.toHaveBeenCalled();
    expect(host.connect).not.toHaveBeenCalled();
    expect(editors.connect).not.toHaveBeenCalled();
  });

  it('ignores a connection offer without a port', async () => {
    const { loaded, parent, host } = startUtilityHost();
    await loaded;
    expect(() =>
      parent.emit('message', {
        data: { type: GlyphTransportMessageType.CONNECTION, connectionId: 'c', identity },
        ports: [],
      }),
    ).not.toThrow();
    expect(host.connect).not.toHaveBeenCalled();
  });

  it('connects a window to the host and its editor, then announces readiness', async () => {
    const { loaded, parent, host, editors } = startUtilityHost();
    await loaded;
    const port = messagePort();
    parent.emit('message', {
      data: { type: GlyphTransportMessageType.CONNECTION, connectionId: 'connection', identity },
      ports: [port],
    });
    expect(host.connect).toHaveBeenCalledExactlyOnceWith('connection', identity, expect.any(Function));
    expect(editors.connect).toHaveBeenCalledExactlyOnceWith('connection', identity, expect.any(Function));
    expect(port.start).toHaveBeenCalledOnce();
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: GlyphTransportMessageType.READY,
      identity,
      hostGeneration: 'generation',
    });
    (host.connect.mock.calls[0]?.[2] as (message: unknown) => void)('host event');
    (editors.connect.mock.calls[0]?.[2] as (message: unknown) => void)('editor request');
    expect(port.postMessage).toHaveBeenNthCalledWith(2, 'host event');
    expect(port.postMessage).toHaveBeenNthCalledWith(3, 'editor request');
  });

  it('routes editor responses to the editor and every other message to the host', async () => {
    const { loaded, parent, host, editors } = startUtilityHost();
    await loaded;
    const port = messagePort();
    parent.emit('message', {
      data: { type: GlyphTransportMessageType.CONNECTION, connectionId: 'connection', identity },
      ports: [port],
    });
    const response = { operationId: 'op', ok: true };
    port.emit('message', { data: { type: GlyphTransportMessageType.EDITOR_RESPONSE, response } });
    port.emit('message', { data: { type: GlyphTransportMessageType.EDITOR_RESPONSE } });
    port.emit('message', { data: undefined });
    expect(editors.receive).toHaveBeenCalledExactlyOnceWith('connection', response);
    expect(host.receive.mock.calls).toEqual([
      ['connection', { type: GlyphTransportMessageType.EDITOR_RESPONSE }],
      ['connection', undefined],
    ]);
  });

  it.each([new Error('Malformed request'), 'Malformed request'])(
    'reports host request failures back to the window (%s)',
    async failure => {
      const { loaded, parent, host } = startUtilityHost();
      await loaded;
      host.receive.mockRejectedValueOnce(failure);
      const port = messagePort();
      parent.emit('message', {
        data: { type: GlyphTransportMessageType.CONNECTION, connectionId: 'connection', identity },
        ports: [port],
      });
      port.emit('message', { data: { requestId: 'r' } });
      await vi.waitFor(() =>
        expect(port.postMessage).toHaveBeenLastCalledWith({
          type: GlyphTransportMessageType.ERROR,
          message: 'Malformed request',
        }),
      );
    },
  );

  it('disconnects the editor and the host when the window port closes', async () => {
    const { loaded, parent, host, editors } = startUtilityHost();
    await loaded;
    const port = messagePort();
    parent.emit('message', {
      data: { type: GlyphTransportMessageType.CONNECTION, connectionId: 'connection', identity },
      ports: [port],
    });
    port.emit('close');
    expect(editors.disconnect).toHaveBeenCalledExactlyOnceWith('connection');
    expect(host.disconnect).toHaveBeenCalledOnce();
  });

  it.each(['SIGTERM', 'SIGINT'])('disposes the host and the runtime before exiting on %s', async name => {
    const { loaded, host, openai, exit, signal } = startUtilityHost();
    await loaded;
    signal(name);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(openai.dispose).toHaveBeenCalledOnce();
    expect(host.dispose.mock.invocationCallOrder[0]).toBeLessThan(openai.dispose.mock.invocationCallOrder[0]!);
  });
});
