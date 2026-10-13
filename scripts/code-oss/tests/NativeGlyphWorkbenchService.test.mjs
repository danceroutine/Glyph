import { build } from 'esbuild';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

it('[round8-09] rehydrates saved conversation history after both trust revocation and restoration', async () => {
  const listeners = new Set();
  const trustListeners = new Set();
  let trusted = true;
  const chat = {
    id: 'chat',
    title: 'Saved',
    accountProvider: 'fixture',
    accountId: 'account',
    modelSlug: 'model',
    updatedAt: '',
    turnCount: 1,
  };
  const state = {
    accounts: [],
    models: [],
    chats: [chat],
    runs: [],
    proposals: [],
    ownerWindowId: 'owner',
    readOnly: false,
    sequence: 0,
  };
  const emit = event => {
    for (const listener of listeners) listener({ event });
  };
  const request = vi.fn(async command => {
    if (command.type === 'attach_workspace') emit({ type: 'initial_state', state });
    if (command.type === 'open_chat')
      emit({
        type: 'run_state',
        run: {
          chatId: 'chat',
          runId: 'saved',
          userText: 'Question',
          text: 'Saved answer',
          reasoning: '',
          tools: [],
          status: 'completed',
        },
      });
  });
  globalThis.__glyphWorkbenchFixture = {
    request,
    connect: async () => request({ type: 'attach_workspace' }),
    onDidReceiveEvent: listener => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    onDidDisconnect: () => ({ dispose() {} }),
  };
  const result = await build({
    entryPoints: ['code-oss/overlay/src/vs/workbench/contrib/glyph/browser/NativeGlyphWorkbenchService.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    plugins: [
      {
        name: 'workbench-services',
        setup(builder) {
          builder.onResolve({ filter: /GlyphEditorAdapter\.js$/ }, args => ({ path: args.path, namespace: 'editor' }));
          builder.onLoad({ filter: /.*/, namespace: 'editor' }, () => ({
            contents: 'export class GlyphEditorAdapter {}',
          }));
          builder.onResolve({ filter: /^#vs\// }, args => {
            if (args.path.startsWith('#vs/base/'))
              return { path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) };
            return { path: args.path, namespace: 'services' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'services' }, args => ({
            contents: args.path.endsWith('GlyphDesktopClient.js')
              ? 'export class GlyphDesktopClient { constructor() { Object.assign(this, globalThis.__glyphWorkbenchFixture); } dispose() {} }'
              : 'const service = () => {}; export { service as IInstantiationService, service as IWorkspaceContextService, service as IWorkspaceTrustManagementService, service as GlyphWorkbenchService };',
          }));
          builder.onResolve({ filter: /^#glyph\// }, args => ({
            path: resolve('src/desktop', args.path.slice(7).replace(/\.js$/, '.ts')),
          }));
        },
      },
    ],
  });
  const { NativeGlyphWorkbenchService } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  );
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
        trustListeners.add(listener);
        return { dispose() {} };
      },
    },
    { createInstance: () => ({ invalidate() {}, dispose() {}, handle() {} }) },
  );
  try {
    await vi.waitFor(() => expect(service.state.transcript.some(entry => entry.text === 'Saved answer')).toBe(true));
    for (const value of [false, true]) {
      trusted = value;
      for (const listener of trustListeners) listener();
      await vi.waitFor(() => expect(service.state.transcript.some(entry => entry.text === 'Saved answer')).toBe(true));
    }
    expect(request.mock.calls.filter(([command]) => command.type === 'open_chat')).toHaveLength(3);
  } finally {
    service.dispose();
    delete globalThis.__glyphWorkbenchFixture;
  }
});
