import { build } from 'esbuild';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
  it('[round2-07] reattaches an existing peer connection after the owning window detaches', async () => {
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
