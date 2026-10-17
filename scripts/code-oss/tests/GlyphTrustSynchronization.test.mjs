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
          builder.onResolve({ filter: /GlyphContextController\.js$/ }, args => ({
            path: args.path,
            namespace: 'context',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'context' }, () => ({
            contents: 'export class GlyphContextController {}',
          }));
          builder.onResolve({ filter: /GlyphProposalEditor\.js$/ }, args => ({
            path: args.path,
            namespace: 'proposal',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'proposal' }, () => ({
            contents: 'export class GlyphProposalEditor {}',
          }));
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
              'const service = () => {}; export { service as IStorageService, service as IInstantiationService, service as IWorkspaceContextService, service as IWorkspaceTrustManagementService, service as IUserDataProfileService, service as GlyphWorkbenchService }; export const StorageScope = { WORKSPACE: 1 }; export const StorageTarget = { MACHINE: 1 };',
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
    { get: () => undefined, store: () => {} },
    {
      getWorkspace: () => ({
        folders: [{ name: 'project', uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' } }],
      }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      onDidChangeWorkspaceName: () => ({ dispose() {} }),
      onDidChangeWorkbenchState: () => ({ dispose() {} }),
    },
    {
      isWorkspaceTrusted: () => trusted,
      onDidChangeTrust: listener => {
        onTrust = listener;
        return { dispose() {} };
      },
    },
    { createInstance: () => ({ invalidate() {}, dispose() {}, handle() {}, changed() {}, refresh: async () => {} }) },
    { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: () => ({ dispose() {} }) },
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
      { get: () => undefined, store: () => {} },
      {
        getWorkspace: () => ({
          folders: [
            { name: 'project', uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' } },
          ],
        }),
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        onDidChangeWorkspaceName: () => ({ dispose() {} }),
        onDidChangeWorkbenchState: () => ({ dispose() {} }),
      },
      {
        isWorkspaceTrusted: () => trusted,
        onDidChangeTrust: listener => {
          onTrust = listener;
          return { dispose() {} };
        },
      },
      { createInstance: () => ({ invalidate() {}, dispose() {}, handle() {}, changed() {}, refresh: async () => {} }) },
      { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: () => ({ dispose() {} }) },
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

it.each(
  [
    { phase: 'port acquisition', event: 'name' },
    { phase: 'handshake', event: 'name' },
    { phase: 'attachment acknowledgement', event: 'name' },
    { phase: 'ready', event: 'name' },
    { phase: 'ready', event: 'state' },
    { phase: 'ready', event: 'name', change: 'configuration' },
    { phase: 'ready', event: 'name', change: 'display only' },
    { phase: 'streaming', event: 'name' },
    { phase: 'waiting_for_question', event: 'name' },
    { phase: 'waiting_for_approval', event: 'name' },
    ...[
      ['selectModel', ['other'], 'select_model'],
      ['answerQuestion', ['chat', 'run', 'question', {}], 'answer_question'],
      ['writeShellInput', ['chat', 'session', 'input', true], 'write_shell_input'],
      ['stopShell', ['chat', 'session'], 'stop_shell_session'],
      ['decideApproval', ['chat', 'run', 'approval', 'allow_once'], 'decide_approval'],
      ['acceptProposalItem', ['chat', 'proposal', 'item'], 'accept_proposal_item'],
      ['rejectProposalItem', ['chat', 'proposal', 'item'], 'reject_proposal_item'],
      ['cancel', [], 'cancel_run'],
    ].map(([action, args, type]) => ({
      phase: 'streaming',
      event: 'pending notification',
      action,
      args,
      type,
      description: `blocks ${type} under the old identity before the workspace change notification arrives`,
    })),
    {
      phase: 'attachment acknowledgement',
      event: 'pending notification',
      action: 'selectModel',
      args: ['other'],
      type: 'select_model',
      description:
        'rechecks workspace identity before dispatching a command that waited for attachment acknowledgement',
    },
  ]
    .flatMap(scenario => [scenario, { ...scenario, boundary: 'profile' }])
    .map(scenario => {
      if (scenario.boundary === 'profile') {
        if (scenario.change === 'display only')
          return {
            ...scenario,
            description: 'keeps Glyph connected when profile metadata changes but its identity is unchanged',
          };
        if (scenario.action)
          return {
            ...scenario,
            description: `blocks ${scenario.type} under the previous profile while ${scenario.phase} before the profile notification arrives`,
          };
        return {
          ...scenario,
          description: `disconnects Glyph with a reload instruction when profiles switch during ${scenario.phase} with unchanged workspace ${scenario.change ?? scenario.event}`,
        };
      }
      return {
        ...scenario,
        description:
          scenario.description ??
          (scenario.change === 'display only'
            ? 'keeps Glyph connected when a display-name notification leaves its workspace binding unchanged'
            : `disconnects Glyph with a reload instruction when the workspace ${scenario.change ?? 'identity'} changes during ${scenario.phase} through its ${scenario.event} event`),
      };
    }),
)('$description', async ({ phase, event, change, action, args, type, boundary }) => {
  const { NativeGlyphWorkbenchService, GlyphDesktopHost } = await modules();
  const identity = { profileId: 'profile', workspaceId: 'workspace', windowId: 'window' };
  const active = ['streaming', 'waiting_for_question', 'waiting_for_approval'].includes(phase);
  const handle = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const host = new GlyphDesktopHost({
    create: async () => ({
      snapshot: async () => ({
        accounts: [],
        models: [],
        chats: [{ id: 'chat' }],
        proposals: [],
        runs: active
          ? [{ chatId: 'chat', runId: 'run', status: phase, text: 'Partial answer', reasoning: '', tools: [] }]
          : [],
      }),
      handle,
      dispose,
      connectionLost: async () => {},
    }),
  });
  const commands = [];
  const tasks = [];
  let started = false;
  let releaseAcknowledgement;
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
  let releasePort;
  globalThis.__glyphTrustPort =
    phase === 'port acquisition'
      ? new Promise(resolve => {
          releasePort = () => resolve(port);
        })
      : port;
  host.connect('connection', identity, envelope => {
    if (phase === 'attachment acknowledgement' && !releaseAcknowledgement && envelope.event.type === 'command_result') {
      releaseAcknowledgement = () => port.emit(envelope);
    } else port.emit(envelope);
  });
  const ready = () => port.emit({ type: 'glyph_connection_ready', identity, hostGeneration: host.generation });
  let workspaceId = identity.workspaceId;
  let profileId = identity.profileId;
  let configuration = 'file:///original.code-workspace';
  const listeners = { name: new Set(), state: new Set(), folders: new Set(), trust: new Set(), profile: new Set() };
  const subscribe = kind => listener => {
    listeners[kind].add(listener);
    return { dispose: () => listeners[kind].delete(listener) };
  };
  const invalidate = vi.fn();
  const service = new NativeGlyphWorkbenchService(
    { get: () => undefined, store: () => {} },
    {
      getWorkspace: () => ({
        id: workspaceId,
        configuration: { toString: () => configuration },
        folders: [{ name: 'project', uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' } }],
      }),
      onDidChangeWorkspaceFolders: subscribe('folders'),
      onDidChangeWorkspaceName: subscribe('name'),
      onDidChangeWorkbenchState: subscribe('state'),
    },
    { isWorkspaceTrusted: () => true, onDidChangeTrust: subscribe('trust') },
    { createInstance: () => ({ invalidate, dispose() {}, handle() {}, changed() {}, refresh: async () => {} }) },
    {
      get currentProfile() {
        return { id: profileId };
      },
      onDidChangeCurrentProfile: subscribe('profile'),
    },
  );
  const connecting = service.connect().catch(error => error);
  try {
    if (phase !== 'port acquisition') await vi.waitFor(() => expect(started).toBe(true));
    if (phase !== 'port acquisition' && phase !== 'handshake') {
      ready();
      if (phase === 'attachment acknowledgement')
        await vi.waitFor(() => expect(releaseAcknowledgement).toBeTypeOf('function'));
      else await connecting;
    }
    service.composer.setDraft('Keep my unsent prompt.');
    const invoke = () => Promise.resolve(service[action](...args)).catch(error => error);
    const waitingCommand = action && phase === 'attachment acknowledgement' ? invoke() : undefined;
    if (boundary === 'profile') {
      if (change !== 'display only') profileId = 'replacement-profile';
    } else if (change === 'configuration') configuration = 'file:///saved.code-workspace';
    else if (change !== 'display only') workspaceId = 'saved-workspace';
    const eventKind = boundary === 'profile' && event !== 'pending notification' ? 'profile' : event;
    for (const listener of listeners[eventKind] ?? []) listener();
    releasePort?.();
    if (phase === 'port acquisition') await vi.waitFor(() => expect(started || service.sessionChanged).toBe(true));
    if (phase === 'port acquisition' || phase === 'handshake') ready();
    releaseAcknowledgement?.();
    if (action) {
      const result = await (waitingCommand ?? invoke());
      await Promise.allSettled(tasks);
      expect.soft(handle.mock.calls.filter(([command]) => command.type === type)).toEqual([]);
      expect.soft(service.state.status).toBe('disconnected');
      if (action !== 'cancel') expect(result).toBeInstanceOf(Error);
    }
    await connecting;
    if (change === 'display only') {
      expect(service.state.status).toBe('ready');
      expect(invalidate).not.toHaveBeenCalled();
      await service.connect();
      await service.selectModel('other');
      expect(handle.mock.calls.filter(([command]) => command.type === 'select_model')).toHaveLength(1);
      expect(dispose).not.toHaveBeenCalled();
      return;
    }
    expect.soft(service.state.status).toBe('disconnected');
    const reloadMessage = boundary === 'profile' ? /profile.*changed.*reload/i : /workspace.*changed.*reload/i;
    expect.soft(service.state.transcript.some(entry => reloadMessage.test(entry.text))).toBe(true);
    expect.soft(invalidate).toHaveBeenCalled();
    expect(service.composer.snapshot.draft).toBe('Keep my unsent prompt.');
    await service.composer.submit(text => service.send(text));
    expect(service.composer.snapshot.draft).toBe('Keep my unsent prompt.');
    await expect(service.connect()).rejects.toThrow(reloadMessage);
    await expect(service.selectModel('other')).rejects.toThrow();
    for (const listener of listeners.trust) listener();
    await Promise.allSettled(tasks);
    expect(handle.mock.calls.filter(([command]) => command.type === 'select_model')).toEqual([]);
    expect(commands.filter(command => command.type === 'attach_workspace')).toHaveLength(
      ['port acquisition', 'handshake'].includes(phase) ? 0 : 1,
    );
    if (!['port acquisition', 'handshake'].includes(phase)) expect(dispose).toHaveBeenCalledOnce();
    if (boundary === 'profile') {
      // Returning to the old profile must not revive its retired port or tokens.
      profileId = identity.profileId;
      for (const listener of listeners.profile) listener();
      await expect(service.connect()).rejects.toThrow(reloadMessage);
      expect(service.state.status).toBe('disconnected');
    }
  } finally {
    releasePort?.();
    releaseAcknowledgement?.();
    service.dispose();
    await Promise.allSettled(tasks);
    await host.dispose();
    delete globalThis.__glyphTrustPort;
  }
});
