import { build } from 'esbuild';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/** Use the real client and Code OSS lifecycle primitives, replacing only Electron's transport. */
async function clientModule(fixture) {
  globalThis.__glyphClientFixture = fixture;
  const result = await build({
    entryPoints: ['code-oss/overlay/src/vs/workbench/contrib/glyph/electron-browser/GlyphDesktopClient.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'isolated-workbench-transport',
        setup(builder) {
          builder.onResolve(
            {
              filter:
                /^(#vs\/base\/parts\/ipc\/electron-browser\/ipc.mp.js|#vs\/base\/parts\/sandbox\/electron-browser\/globals.js)$/,
            },
            args => ({ path: args.path, namespace: 'transport' }),
          );
          builder.onLoad({ filter: /.*/, namespace: 'transport' }, args => ({
            contents: args.path.endsWith('ipc.mp.js')
              ? 'export const acquirePort = async () => globalThis.__glyphClientFixture.port;'
              : 'export const ipcRenderer = { on() {}, removeListener() {} };',
            loader: 'js',
          }));
          builder.onResolve({ filter: /^#(vs|glyph|src)\// }, args => {
            const roots = { vs: '.code-oss/src/src/vs', glyph: 'src/desktop', src: 'src' };
            const [, alias, path] = /^#(vs|glyph|src)\/(.*)$/.exec(args.path);
            return { path: resolve(roots[alias], path.replace(/\.js$/, '.ts')) };
          });
        },
      },
    ],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

describe('Glyph desktop connection attachment', () => {
  it.each(['trust', 'roots', 'trust restored'])(
    'retries a superseded attachment failure with the latest %s configuration',
    async change => {
      const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };
      const requests = [];
      let sequence = 0;
      class FixturePort extends EventTarget {
        start() {
          this.dispatchEvent(
            new MessageEvent('message', { data: { type: 'glyph_connection_ready', identity, hostGeneration: 'host' } }),
          );
        }
        close() {}
        emit(event) {
          this.dispatchEvent(
            new MessageEvent('message', {
              data: { ...identity, protocolVersion: 1, hostGeneration: 'host', sequence: ++sequence, event },
            }),
          );
        }
        postMessage(request) {
          requests.push(request);
          if (requests.length > 1)
            queueMicrotask(() => {
              if (request.command.type === 'attach_workspace')
                this.emit({
                  type: 'initial_state',
                  state: {
                    accounts: [],
                    models: [],
                    chats: [],
                    runs: [],
                    proposals: [],
                    readOnly: false,
                    ownerWindowId: identity.windowId,
                    sequence: sequence + 1,
                  },
                });
              this.emit({ type: 'command_result', requestId: request.requestId, ok: true });
            });
        }
      }
      const port = new FixturePort();
      const { GlyphDesktopClient } = await clientModule({ port });
      const client = new GlyphDesktopClient(async () => {
        throw new Error('No editor requests expected');
      });
      const roots = [{ name: 'project', uri: 'file:///project', canonicalPath: '/project' }];
      const latestRoots =
        change === 'roots' ? [{ name: 'other', uri: 'file:///other', canonicalPath: '/other' }] : roots;
      const trusted = change !== 'trust';
      const first = client.connect(roots, true).catch(error => error);
      try {
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        if (change === 'trust restored') void client.connect(roots, false).catch(() => {});
        const latest = client.connect(latestRoots, trusted).catch(error => error);
        const send = client.request({ type: 'open_chat', chatId: 'saved-chat' }).catch(error => error);
        port.emit({
          type: 'error',
          requestId: requests[0].requestId,
          error: { code: 'UNTRUSTED_WORKSPACE', message: 'Recovery was invalidated.', retryable: false },
        });
        expect(await first).toBeUndefined();
        expect(await latest).toBeUndefined();
        expect(await send).toBeUndefined();
        expect(requests.map(request => request.command)).toEqual([
          expect.objectContaining({ type: 'attach_workspace', roots, trusted: true }),
          expect.objectContaining({ type: 'attach_workspace', roots: latestRoots, trusted }),
          { type: 'open_chat', chatId: 'saved-chat' },
        ]);
      } finally {
        client.dispose();
        delete globalThis.__glyphClientFixture;
      }
    },
  );

  it('does not retry an attachment failure when its configuration is still current', async () => {
    const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };
    const requests = [];
    class FixturePort extends EventTarget {
      start() {
        this.dispatchEvent(
          new MessageEvent('message', { data: { type: 'glyph_connection_ready', identity, hostGeneration: 'host' } }),
        );
      }
      close() {}
      postMessage(request) {
        requests.push(request);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', {
              data: {
                ...identity,
                protocolVersion: 1,
                hostGeneration: 'host',
                sequence: requests.length,
                event: {
                  type: 'error',
                  requestId: request.requestId,
                  error: { code: 'INTERNAL', message: 'Recovery failed.', retryable: true },
                },
              },
            }),
          ),
        );
      }
    }
    const { GlyphDesktopClient } = await clientModule({ port: new FixturePort() });
    const client = new GlyphDesktopClient(async () => {
      throw new Error('No editor requests expected');
    });
    try {
      await expect(client.connect([], true)).rejects.toThrow('Recovery failed.');
      expect(requests).toHaveLength(1);
    } finally {
      client.dispose();
      delete globalThis.__glyphClientFixture;
    }
  });

  it('reattaches an existing peer connection after the owning window detaches', async () => {
    const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'peer' };
    const requests = [];
    let sequence = 0;
    class FixturePort extends EventTarget {
      start() {
        this.dispatchEvent(
          new MessageEvent('message', { data: { type: 'glyph_connection_ready', identity, hostGeneration: 'host' } }),
        );
      }
      close() {}
      emit(event) {
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { ...identity, protocolVersion: 1, hostGeneration: 'host', sequence: ++sequence, event },
          }),
        );
      }
      postMessage(request) {
        requests.push(request);
        queueMicrotask(() => {
          if (request.command.type === 'attach_workspace')
            this.emit({
              type: 'initial_state',
              state: {
                accounts: [],
                models: [],
                chats: [],
                runs: [],
                proposals: [],
                readOnly: requests.length === 1,
                ownerWindowId: requests.length === 1 ? 'owner' : 'peer',
                sequence: sequence + 1,
              },
            });
          this.emit({ type: 'command_result', requestId: request.requestId, ok: true });
        });
      }
    }
    const port = new FixturePort();
    const { GlyphDesktopClient } = await clientModule({ port });
    const client = new GlyphDesktopClient(async () => {
      throw new Error('No editor requests expected');
    });
    const snapshots = [];
    client.onDidReceiveEvent(envelope => {
      if (envelope.event.type === 'initial_state') snapshots.push(envelope.event.state);
    });
    try {
      const roots = [{ name: 'project', uri: 'file:///project', canonicalPath: '/project' }];
      await client.connect(roots, true);
      port.emit({ type: 'host_status', status: 'disconnected', message: 'The owning window detached.' });
      await client.connect(roots, true);
      expect(requests.filter(request => request.command.type === 'attach_workspace')).toHaveLength(2);
      expect(snapshots.map(({ ownerWindowId, readOnly }) => ({ ownerWindowId, readOnly }))).toEqual([
        { ownerWindowId: 'owner', readOnly: true },
        { ownerWindowId: 'peer', readOnly: false },
      ]);
    } finally {
      client.dispose();
      delete globalThis.__glyphClientFixture;
    }
  });
});
