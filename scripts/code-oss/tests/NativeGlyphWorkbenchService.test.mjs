import { build } from 'esbuild';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';

let loaded;
async function modules() {
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
          builder.onResolve({ filter: /GlyphPlanEditor\.js$/ }, args => ({ path: args.path, namespace: 'plan' }));
          builder.onLoad({ filter: /.*/, namespace: 'plan' }, () => ({ contents: 'export class GlyphPlanInput {}' }));
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
          builder.onResolve({ filter: /^#vs\// }, args => {
            if (args.path.startsWith('#vs/base/'))
              return { path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) };
            return { path: args.path, namespace: 'services' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'services' }, args => ({
            contents: args.path.endsWith('GlyphDesktopClient.js')
              ? 'export class GlyphDesktopClient { constructor() { Object.assign(this, globalThis.__glyphWorkbenchFixture); } dispose() {} }'
              : 'const service = () => {}; export { service as IEditorService, service as IOpenerService, service as IStorageService, service as IInstantiationService, service as IWorkspaceContextService, service as IWorkspaceTrustManagementService, service as IUserDataProfileService, service as GlyphWorkbenchService }; export const StorageScope = { WORKSPACE: 1 }; export const StorageTarget = { MACHINE: 1 };',
          }));
          builder.onResolve({ filter: /^#glyph\// }, args => ({
            path: resolve('src/desktop', args.path.slice(7).replace(/\.js$/, '.ts')),
          }));
        },
      },
    ],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

function chat(id) {
  return { id, title: id, accountProvider: 'fixture', accountId: 'a', modelSlug: 'model', updatedAt: '', turnCount: 1 };
}

async function fixture({ chats = [chat('alpha'), chat('beta')], accounts = [], handler = async () => {} } = {}) {
  const { NativeGlyphWorkbenchService } = await (loaded ??= modules());
  const listeners = new Set();
  const trustListeners = new Set();
  const storage = new Map();
  let trusted = true;
  const state = {
    accounts,
    models: [],
    chats,
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
    if (command.type === 'attach_workspace' || command.type === 'request_snapshot')
      emit({ type: 'initial_state', state: { ...state } });
    await handler(command, { state, emit });
    if (command.type === 'open_chat')
      emit({
        type: 'run_state',
        run: {
          chatId: command.chatId,
          runId: command.chatId,
          userText: 'Question',
          text: `${command.chatId} answer`,
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
  const service = new NativeGlyphWorkbenchService(
    { get: key => storage.get(key), store: (key, value) => storage.set(key, value) },
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
        trustListeners.add(listener);
        return { dispose() {} };
      },
    },
    { createInstance: () => ({ invalidate() {}, dispose() {}, handle() {}, changed() {}, refresh: async () => {} }) },
    { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: () => ({ dispose() {} }) },
  );
  await service.connect();
  return {
    service,
    state,
    emit,
    request,
    storage,
    setTrust: value => {
      trusted = value;
      for (const listener of trustListeners) listener();
    },
    dispose: () => {
      service.dispose();
      delete globalThis.__glyphWorkbenchFixture;
    },
  };
}

it('rehydrates saved conversation history after both trust revocation and restoration', async () => {
  const test = await fixture();
  try {
    for (const value of [false, true]) {
      test.setTrust(value);
      await vi.waitFor(() =>
        expect(test.service.state.transcript.some(entry => entry.text === 'alpha answer')).toBe(true),
      );
    }
    expect(test.request.mock.calls.filter(([command]) => command.type === 'open_chat').length).toBeGreaterThanOrEqual(
      3,
    );
  } finally {
    test.dispose();
  }
});

it('ignores late navigation completions and retains a separate composer for each chat and the new-chat draft', async () => {
  let release;
  let delay = false;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const test = await fixture({
    handler: async command => {
      if (delay && command.type === 'open_chat' && command.chatId === 'beta') await gate;
    },
  });
  try {
    test.service.composer.setDraft('alpha draft');
    delay = true;
    const pending = test.service.openChat('beta');
    await vi.waitFor(() => expect(test.service.state.navigationPending).toBe(true));
    test.service.newChat();
    test.service.composer.setDraft('new draft');
    release();
    await pending;
    expect(test.service.state.selectedChatId).toBeUndefined();
    expect(test.service.composer.snapshot.draft).toBe('new draft');
    await test.service.openChat('alpha');
    expect(test.service.composer.snapshot.draft).toBe('alpha draft');
    expect(test.storage.get('glyph.selectedChat')).toBe('alpha');
    await test.service.openChat('beta');
    expect(test.service.composer.snapshot.draft).toBe('');
    test.service.composer.setDraft('beta draft');
    test.service.newChat();
    expect(test.service.composer.snapshot.draft).toBe('new draft');
    await test.service.openChat('beta');
    expect(test.service.composer.snapshot.draft).toBe('beta draft');
  } finally {
    release();
    test.dispose();
  }
});

const accounts = ['a', 'b'].map(id => ({ provider: 'fixture', id, label: id, connected: true, inferenceAccess: true }));

it('restores the draft account catalog before changing models after host replacement', async () => {
  const test = await fixture({
    chats: [],
    accounts,
    handler: async (command, { state }) => {
      if (command.type === 'select_account') {
        state.selectedAccount = { provider: command.accountProvider, id: command.accountId };
        state.models = [
          { slug: 'model', name: 'Model' },
          { slug: 'deep', name: 'Deep' },
        ];
      }
      if (command.type === 'select_model' && !state.models.some(model => model.slug === command.model))
        throw new Error('No catalog on this host');
    },
  });
  try {
    test.service.composer.setDraft('Keep the unsent draft');
    delete test.state.selectedAccount;
    test.state.models = [];
    test.emit({ type: 'initial_state', state: { ...test.state } });
    test.request.mockClear();
    await test.service.selectModel('deep');
    expect(
      test.request.mock.calls
        .filter(([command]) => ['select_account', 'select_model'].includes(command.type))
        .map(([command]) => command.type),
    ).toEqual(['select_account', 'select_model']);
    expect(test.service.state.selectedModel).toBe('deep');
    expect(test.service.composer.snapshot.draft).toBe('Keep the unsent draft');
  } finally {
    test.dispose();
  }
});

it('does not replace the current model choices when an older account discovery finishes late', async () => {
  let release;
  let delay = false;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const test = await fixture({
    chats: [],
    accounts,
    handler: async (command, { state }) => {
      if (command.type !== 'select_account') return;
      if (delay && command.accountId === 'a') await gate;
      state.models = [{ slug: `${command.accountId}-model`, name: command.accountId }];
    },
  });
  try {
    delay = true;
    const pending = test.service.selectAccount('fixture', 'a');
    await test.service.selectAccount('fixture', 'b');
    release();
    await pending;
    expect(test.service.state.selectedAccount).toEqual({ provider: 'fixture', id: 'b' });
    expect(test.service.state.models).toEqual([{ slug: 'b-model', name: 'b' }]);
    expect(test.service.state.selectedModel).toBe('b-model');
  } finally {
    release();
    test.dispose();
  }
});

it('selects only the correlated created chat and transfers its composer without following background chat updates', async () => {
  const test = await fixture({
    chats: [],
    accounts,
    handler: async (command, { state, emit }) => {
      if (command.type === 'select_account') state.models = [{ slug: 'model', name: 'Model' }];
      if (command.type === 'create_chat') {
        state.chats.push(chat('created'), chat('unrelated'));
        emit({ type: 'chat_updated', chat: chat('created'), creationId: command.creationId });
        emit({ type: 'chat_updated', chat: chat('unrelated') });
      }
    },
  });
  try {
    const original = test.service.composer;
    await test.service.createChat('fixture', 'a', 'model');
    expect(test.service.state.selectedChatId).toBe('created');
    expect(test.service.composer).toBe(original);
    test.service.newChat();
    expect(test.service.composer).not.toBe(original);
  } finally {
    test.dispose();
  }
});

it('waits for an acknowledged model choice before creating the conversation on send', async () => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const test = await fixture({
    chats: [],
    accounts,
    handler: async (command, { state, emit }) => {
      if (command.type === 'select_account')
        state.models = [
          { slug: 'model', name: 'Model' },
          { slug: 'deep', name: 'Deep' },
        ];
      if (command.type === 'select_model') await gate;
      if (command.type === 'create_chat') {
        const created = { ...chat('created'), modelSlug: command.model };
        state.chats.push(created);
        emit({ type: 'chat_updated', chat: created, creationId: command.creationId });
      }
    },
  });
  try {
    const selecting = test.service.selectModel('deep');
    expect(test.service.state.catalogPending).toBe(true);
    const sending = test.service.send('Use the selected model');
    await vi.waitFor(() =>
      expect(test.request.mock.calls.some(([command]) => command.type === 'select_model')).toBe(true),
    );
    expect(test.request.mock.calls.some(([command]) => command.type === 'create_chat')).toBe(false);
    release();
    await selecting;
    await sending;
    expect(test.request.mock.calls.find(([command]) => command.type === 'create_chat')[0].model).toBe('deep');
    expect(test.service.state.catalogPending).toBe(false);
  } finally {
    release();
    test.dispose();
  }
});
