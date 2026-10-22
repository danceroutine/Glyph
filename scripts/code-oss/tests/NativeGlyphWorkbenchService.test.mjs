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
          builder.onResolve({ filter: /GlyphShellTerminals\.js$/ }, args => ({
            path: args.path,
            namespace: 'shell-viewers',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'shell-viewers' }, () => ({
            contents: 'export class GlyphShellTerminals {}',
          }));
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
            if (args.path.startsWith('#vs/base/') || args.path.endsWith('/browserViewUri.js'))
              return { path: resolve('.code-oss/src/src/vs', args.path.slice(4).replace(/\.js$/, '.ts')) };
            return { path: args.path, namespace: 'services' };
          });
          builder.onLoad({ filter: /.*/, namespace: 'services' }, args => ({
            contents: args.path.endsWith('GlyphDesktopClient.js')
              ? 'export class GlyphDesktopClient { constructor() { Object.assign(this, globalThis.__glyphWorkbenchFixture); } dispose() {} }'
              : 'const service = () => {}; export { service as IClipboardService, service as IConfigurationService, service as IEditorService, service as IOpenerService, service as IStorageService, service as IInstantiationService, service as IWorkspaceContextService, service as IWorkspaceTrustManagementService, service as IUserDataProfileService, service as GlyphWorkbenchService }; export const StorageScope = { WORKSPACE: 1 }; export const StorageTarget = { MACHINE: 1 };',
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

async function fixture({
  chats = [chat('alpha'), chat('beta')],
  accounts = [],
  handler = async () => {},
  openInGlyph = false,
  storage = new Map(),
} = {}) {
  const { NativeGlyphWorkbenchService } = await (loaded ??= modules());
  const listeners = new Set();
  const trustListeners = new Set();
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
  const editors = { openEditor: vi.fn() };
  const opener = { open: vi.fn() };
  const service = new NativeGlyphWorkbenchService(
    {
      get: key => storage.get(key),
      getObject: (key, _scope, fallback) => storage.get(key) ?? fallback,
      store: (key, value) => storage.set(key, value),
    },
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
    {
      createInstance: () => ({
        invalidate() {},
        dispose() {},
        handle() {},
        changed() {},
        update() {},
        refresh: async () => {},
      }),
    },
    { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: () => ({ dispose() {} }) },
    editors,
    { writeText: vi.fn() },
    opener,
    {
      getValue: key => (key === 'glyph.preferOpeningWebLinksInGlyph' ? openInGlyph : undefined),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  );
  await service.connect();
  return {
    service,
    editors,
    opener,
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

it('keeps typed new-chat text as a draft across a reload until it becomes a conversation', async () => {
  const storage = new Map();
  const first = await fixture({ storage });
  let createdAt;
  try {
    first.service.composer.setDraft('alpha draft');
    expect(first.service.state.newChatDraft).toBeUndefined();
    first.service.newChat();
    first.service.composer.setDraft('   ');
    expect(first.service.state.newChatDraft).toBeUndefined();
    first.service.composer.setDraft('Get me a screenshot');
    createdAt = first.service.state.newChatDraft.createdAt;
    expect(Date.parse(createdAt)).not.toBeNaN();
    first.service.composer.setDraft('Get me a screenshot of the sidebar');
    expect(first.service.state.newChatDraft).toEqual({ text: 'Get me a screenshot of the sidebar', createdAt });
  } finally {
    first.dispose();
  }
  const reloaded = await fixture({ storage });
  try {
    expect(reloaded.service.state.newChatDraft).toEqual({ text: 'Get me a screenshot of the sidebar', createdAt });
    expect(reloaded.service.composer.snapshot.draft).toBe('Get me a screenshot of the sidebar');
    reloaded.service.composer.setDraft('');
    expect(reloaded.service.state.newChatDraft).toBeUndefined();
    expect(storage.get('glyph.newChatDraft')).toBeUndefined();
  } finally {
    reloaded.dispose();
  }
});

it('stops listing the draft once its text moves into a created conversation', async () => {
  const test = await fixture({
    chats: [],
    accounts: [{ provider: 'fixture', id: 'a', label: 'a', connected: true, inferenceAccess: true }],
    handler: async (command, { state, emit }) => {
      if (command.type === 'select_account') state.models = [{ slug: 'model', name: 'Model' }];
      if (command.type === 'create_chat') {
        state.chats.push(chat('created'));
        emit({ type: 'chat_updated', chat: chat('created'), creationId: command.creationId });
      }
    },
  });
  try {
    test.service.composer.setDraft('Carry this over');
    expect(test.service.state.newChatDraft?.text).toBe('Carry this over');
    await test.service.createChat('fixture', 'a', 'model');
    expect(test.service.state.selectedChatId).toBe('created');
    expect(test.service.composer.snapshot.draft).toBe('Carry this over');
    expect(test.service.state.newChatDraft).toBeUndefined();
    expect(test.storage.get('glyph.newChatDraft')).toBeUndefined();
  } finally {
    test.dispose();
  }
});

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

it('gives restored captures local IDs so a folder can be refreshed independently', async () => {
  const test = await fixture();
  try {
    const composer = test.service.composer;
    const folder = {
      kind: 'folder',
      uri: 'file:///project/src',
      path: 'src',
      text: 'file.ts',
      contentRevision: 'tree',
    };
    const file = {
      id: 'existing-file',
      kind: 'file',
      uri: 'file:///project/src/file.ts',
      path: 'src/file.ts',
      text: 'original',
      contentRevision: 'file',
    };
    test.emit({
      type: 'chat_restored',
      chatId: 'alpha',
      runs: [],
      draft: { text: '@src @src/file.ts', attachments: [folder, file] },
    });
    const captures = composer.snapshot.document.parts
      .filter(part => part.type === 'attachment')
      .map(part => part.attachment);
    expect(captures[0].id).toEqual(expect.any(String));
    expect(captures[0].kind).toBe('folder');
    expect(captures[1].id).toBe('existing-file');
    composer.replaceAttachment(captures[0].id, { ...captures[0], text: 'file.ts\nadded.ts' });
    const refreshed = composer.snapshot.document.parts
      .filter(part => part.type === 'attachment')
      .map(part => part.attachment);
    expect(refreshed[0].text).toContain('added.ts');
    expect(refreshed[1]).toEqual(file);
  } finally {
    test.dispose();
  }
});

it('opens web links externally by default and uses the native browser editor when preferred', async () => {
  for (const openInGlyph of [false, true]) {
    const f = await fixture({ openInGlyph });
    try {
      await f.service.openLink('https://example.com/article');
      if (openInGlyph) {
        expect(f.editors.openEditor).toHaveBeenCalledWith(
          expect.objectContaining({ options: { pinned: true, viewState: { url: 'https://example.com/article' } } }),
        );
        expect(f.opener.open).not.toHaveBeenCalled();
      } else {
        expect(f.opener.open).toHaveBeenCalledWith(expect.anything(), { allowCommands: false, openExternal: true });
        expect(f.editors.openEditor).not.toHaveBeenCalled();
      }
      await expect(f.service.openLink('https://user:password@example.com')).rejects.toThrow('credentials');
    } finally {
      f.dispose();
    }
  }
});

it.each([false, true])('shows a plan as building until its build finishes (new chat: %s)', async newChat => {
  const plan = {
    id: 'plan',
    revision: 1,
    title: 'Approved work',
    summary: '',
    markdown: 'Change source',
    todos: [],
    agents: [],
  };
  let build;
  const test = await fixture({
    chats: [{ ...chat('alpha'), plans: [plan] }],
    handler: async (command, { state, emit }) => {
      if (command.type === 'create_chat') {
        state.chats.push(chat('builder'));
        emit({ type: 'chat_updated', chat: chat('builder'), creationId: command.creationId });
      }
      if (command.type !== 'send') return;
      build = {
        chatId: command.chatId,
        runId: command.runId,
        userText: command.text,
        text: '',
        reasoning: '',
        tools: [],
      };
      emit({ type: 'run_state', run: { ...build, status: 'streaming' } });
    },
  });
  try {
    expect(test.service.state.buildingPlanIds).toBeUndefined();
    await test.service.buildPlan('alpha', plan, newChat);
    expect(build.chatId).toBe(newChat ? 'builder' : 'alpha');
    expect(test.service.state.buildingPlanIds).toEqual(['plan']);
    test.emit({ type: 'run_state', run: { ...build, status: 'completed' } });
    expect(test.service.state.buildingPlanIds).toBeUndefined();
  } finally {
    test.dispose();
  }
});

it('does not show a plan as building when its build finishes before the request settles', async () => {
  const plan = {
    id: 'plan',
    revision: 1,
    title: 'Approved work',
    summary: '',
    markdown: 'Change source',
    todos: [],
    agents: [],
  };
  const test = await fixture({
    chats: [{ ...chat('alpha'), plans: [plan] }],
    handler: async (command, { emit }) => {
      if (command.type !== 'send') return;
      emit({
        type: 'run_state',
        run: {
          chatId: command.chatId,
          runId: command.runId,
          userText: command.text,
          text: 'Done',
          reasoning: '',
          tools: [],
          status: 'completed',
        },
      });
    },
  });
  try {
    await test.service.buildPlan('alpha', plan);
    expect(test.service.state.buildingPlanIds).toBeUndefined();
  } finally {
    test.dispose();
  }
});

it('stops showing a plan as building when the host no longer reports its build', async () => {
  const plan = {
    id: 'plan',
    revision: 1,
    title: 'Approved work',
    summary: '',
    markdown: 'Change source',
    todos: [],
    agents: [],
  };
  const test = await fixture({
    chats: [{ ...chat('alpha'), plans: [plan] }],
    handler: async (command, { emit }) => {
      if (command.type !== 'send') return;
      emit({
        type: 'run_state',
        run: {
          chatId: command.chatId,
          runId: command.runId,
          userText: command.text,
          text: '',
          reasoning: '',
          tools: [],
          status: 'streaming',
        },
      });
    },
  });
  try {
    await test.service.buildPlan('alpha', plan);
    expect(test.service.state.buildingPlanIds).toEqual(['plan']);
    test.emit({ type: 'initial_state', state: { ...test.state, runs: [] } });
    expect(test.service.state.buildingPlanIds).toBeUndefined();
  } finally {
    test.dispose();
  }
});

it('sends a build as a build order carrying the plan’s todos', async () => {
  const plan = {
    id: 'plan',
    revision: 2,
    title: 'Approved work',
    summary: '',
    markdown: 'Change source',
    todos: [
      { id: 'first', text: 'First step', completed: true },
      { id: 'second', text: 'Second step', completed: false },
    ],
    agents: [],
  };
  let sent;
  const test = await fixture({
    chats: [{ ...chat('alpha'), plans: [plan] }],
    handler: async command => {
      if (command.type === 'send') sent = command;
    },
  });
  try {
    await test.service.buildPlan('alpha', plan);

    expect(sent.options.planBuild).toEqual({
      planId: 'plan',
      revision: 2,
      title: 'Approved work',
      sourceChatId: 'alpha',
      todos: plan.todos,
    });
    expect(sent.text).toContain('- [ ] Second step (todo id: second)');
  } finally {
    test.dispose();
  }
});

it('notes build progress on messages written while a plan is building in that chat', async () => {
  const plan = {
    id: 'plan',
    revision: 1,
    title: 'Approved work',
    summary: '',
    markdown: 'Change source',
    todos: [],
    agents: [],
  };
  const test = await fixture({
    chats: [{ ...chat('alpha'), plans: [plan] }, chat('beta')],
    handler: async (command, { emit }) => {
      if (command.type !== 'send') return;
      emit({
        type: 'run_state',
        run: {
          chatId: command.chatId,
          runId: command.runId,
          userText: command.text,
          text: '',
          reasoning: '',
          tools: [],
          status: 'streaming',
        },
      });
    },
  });
  try {
    await test.service.buildPlan('alpha', plan);
    test.emit({
      type: 'chat_updated',
      chat: {
        ...chat('alpha'),
        plans: [plan],
        todos: [
          { id: 'first', text: 'First step', status: 'completed' },
          { id: 'second', text: 'Second step', status: 'in_progress' },
          { id: 'third', text: 'Third step', status: 'pending' },
        ],
      },
    });
    test.service.composer.setDraft('Keep the public API unchanged');
    test.service.composer.enqueueDraft();
    const queued = test.service.composer.snapshot.queued[0];
    await test.service.openChat('beta');
    test.service.composer.setDraft('Unrelated question');
    test.service.composer.enqueueDraft();

    expect(queued.document.options.planProgress).toEqual({
      planId: 'plan',
      title: 'Approved work',
      current: 'Second step',
      completed: 1,
      total: 3,
    });
    expect(test.service.composer.snapshot.queued[0].document.options.planProgress).toBeUndefined();
  } finally {
    test.dispose();
  }
});
