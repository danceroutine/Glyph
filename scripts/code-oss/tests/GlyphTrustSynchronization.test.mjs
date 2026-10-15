import { build } from 'esbuild';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

// Keep service, client, coordinator, and Code OSS events real. Only Electron's
// port acquisition, editor services, and the provider runtime are fixture ports.
async function modules() {
  const result = await build({
    stdin: {
      contents: `
      export { NativeGlyphWorkbenchService } from '#vs/workbench/contrib/glyph/browser/NativeGlyphWorkbenchService.js';
      export { GlyphDesktopHost } from '#src/desktop/host/GlyphDesktopHost.js';
    `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    plugins: [
      {
        name: 'trust-fixture',
        setup(builder) {
          builder.onResolve({ filter: /GlyphEditorAdapter\.js$/ }, args => ({ path: args.path, namespace: 'editor' }));
          builder.onLoad({ filter: /.*/, namespace: 'editor' }, () => ({
            contents: 'export class GlyphEditorAdapter {}',
          }));
          builder.onResolve(
            {
              filter:
                /^(#vs\/base\/parts\/ipc\/electron-browser\/ipc.mp.js|#vs\/base\/parts\/sandbox\/electron-browser\/globals.js)$/,
            },
            args => ({ path: args.path, namespace: 'transport' }),
          );
          builder.onLoad({ filter: /.*/, namespace: 'transport' }, args => ({
            contents: args.path.endsWith('ipc.mp.js')
              ? 'export const acquirePort = async () => globalThis.__glyphTrustPort;'
              : 'export const ipcRenderer = { on() {}, removeListener() {} };',
          }));
          builder.onResolve({ filter: /^#vs\// }, args => {
            if (args.path.startsWith('#vs/base/'))
              return { path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) };
            if (/\/(NativeGlyphWorkbenchService|GlyphDesktopClient)\.js$/.test(args.path))
              return { path: resolve('code-oss/overlay/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) };
            return { path: args.path, namespace: 'services' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'services' }, () => ({
            contents:
              'const service = () => {}; export { service as IInstantiationService, service as IWorkspaceContextService, service as IWorkspaceTrustManagementService, service as GlyphWorkbenchService };',
          }));
          builder.onResolve({ filter: /^#(glyph|src)\// }, args => ({
            path: resolve(
              args.path.startsWith('#glyph/') ? 'src/desktop' : 'src',
              args.path.replace(/^#(glyph|src)\//, '').replace(/\.js$/, '.ts'),
            ),
          }));
        },
      },
    ],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

it('loads saved history through the latest untrusted attachment when revocation invalidates initial recovery', async () => {
  const { NativeGlyphWorkbenchService, GlyphDesktopHost } = await modules();
  const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };
  const configurations = [];
  let denyRecovery;
  const handle = vi.fn(async () => {});
  const host = new GlyphDesktopHost({
    create: async configuration => {
      configurations.push(configuration);
      if (configurations.length === 1)
        await new Promise((_resolve, reject) => {
          denyRecovery = () => reject(new Error('Workspace trust is required to recover this review.'));
        });
      return {
        snapshot: async () => ({ accounts: [], models: [], chats: [{ id: 'saved-chat' }], runs: [], proposals: [] }),
        handle,
        connectionLost: async () => {},
        dispose: async () => {},
      };
    },
  });
  const tasks = [];
  class Port extends EventTarget {
    start() {
      this.emit({ type: 'glyph_connection_ready', identity, hostGeneration: host.generation });
    }
    close() {}
    postMessage(request) {
      tasks.push(host.receive('connection', request));
    }
    emit(data) {
      this.dispatchEvent(new MessageEvent('message', { data }));
    }
  }
  const port = new Port();
  globalThis.__glyphTrustPort = port;
  host.connect('connection', identity, envelope => port.emit(envelope));
  let trusted = true;
  let onTrust;
  const service = new NativeGlyphWorkbenchService(
    {
      getWorkspace: () => ({
        folders: [{ name: 'project', uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' } }],
      }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    },
    {
      isWorkspaceTrusted: () => trusted,
      onDidChangeTrust: listener => {
        onTrust = listener;
        return { dispose() {} };
      },
    },
    { createInstance: () => ({ invalidate() {}, dispose() {}, handle() {} }) },
  );
  const connecting = service.connect().catch(error => error);
  try {
    await vi.waitFor(() => expect(denyRecovery).toBeTypeOf('function'));
    trusted = false;
    onTrust();
    denyRecovery();
    expect(await connecting).toBeUndefined();
    expect(configurations.map(configuration => configuration.trusted)).toEqual([true, false]);
    expect(service.state.chats.map(chat => chat.id)).toEqual(['saved-chat']);
    await expect(
      service.client.request({
        type: 'send',
        chatId: 'saved-chat',
        runId: 'forbidden',
        text: 'not authorized',
        attachments: [],
      }),
    ).rejects.toThrow('UNTRUSTED_WORKSPACE');
    expect(handle.mock.calls.filter(([command]) => command.type === 'send')).toEqual([]);
  } finally {
    denyRecovery?.();
    service.dispose();
    await Promise.allSettled(tasks);
    await host.dispose();
    delete globalThis.__glyphTrustPort;
  }
});

it.each(['handshake', 'attach acknowledgement'])(
  'revokes host authorization when trust changes during %s',
  async phase => {
    const { NativeGlyphWorkbenchService, GlyphDesktopHost } = await modules();
    const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };
    const handle = vi.fn(async () => {});
    const host = new GlyphDesktopHost({
      create: async () => ({
        snapshot: async () => ({ accounts: [], models: [], chats: [{ id: 'chat' }], runs: [], proposals: [] }),
        handle,
        connectionLost: async () => {},
        dispose: async () => {},
      }),
    });
    const commands = [];
    const tasks = [];
    let releaseAcknowledgement;
    let started = false;
    let ready;
    class Port extends EventTarget {
      start() {
        started = true;
      }
      close() {}
      postMessage(request) {
        commands.push(request.command);
        tasks.push(host.receive('connection', request));
      }
      emit(data) {
        this.dispatchEvent(new MessageEvent('message', { data }));
      }
    }
    const port = new Port();
    globalThis.__glyphTrustPort = port;
    host.connect('connection', identity, envelope => {
      if (phase === 'attach acknowledgement' && !releaseAcknowledgement && envelope.event.type === 'command_result') {
        releaseAcknowledgement = () => port.emit(envelope);
      } else port.emit(envelope);
    });
    ready = () => port.emit({ type: 'glyph_connection_ready', identity, hostGeneration: host.generation });
    let trusted = true;
    let onTrust;
    const service = new NativeGlyphWorkbenchService(
      {
        getWorkspace: () => ({
          folders: [
            { name: 'project', uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' } },
          ],
        }),
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      },
      {
        isWorkspaceTrusted: () => trusted,
        onDidChangeTrust: listener => {
          onTrust = listener;
          return { dispose() {} };
        },
      },
      { createInstance: () => ({ invalidate() {}, dispose() {}, handle() {} }) },
    );
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      if (phase === 'attach acknowledgement') {
        ready();
        await vi.waitFor(() => expect(releaseAcknowledgement).toBeTypeOf('function'));
      }
      trusted = false;
      onTrust();
      const direct = service.client
        .request({ type: 'send', chatId: 'chat', runId: 'direct', text: 'direct port command', attachments: [] })
        .then(
          () => undefined,
          error => error,
        );
      const sent = service.send('must not reach the runtime').then(
        () => undefined,
        error => error,
      );
      if (phase === 'handshake') ready();
      else releaseAcknowledgement();
      await sent;
      expect(await direct).toBeInstanceOf(Error);
      expect(handle.mock.calls.filter(([command]) => command.type === 'send')).toEqual([]);
      expect(commands.filter(command => command.type === 'attach_workspace').at(-1).trusted).toBe(false);
      // A later action must not quietly reuse the stale trusted attachment either.
      await service.send('still untrusted').catch(() => {});
      expect(handle.mock.calls.filter(([command]) => command.type === 'send')).toEqual([]);
      trusted = true;
      onTrust();
      await service.send('restored trust');
      expect(handle.mock.calls.filter(([command]) => command.type === 'send')).toHaveLength(1);
    } finally {
      service.dispose();
      await Promise.allSettled(tasks);
      await host.dispose();
      delete globalThis.__glyphTrustPort;
    }
  },
);
