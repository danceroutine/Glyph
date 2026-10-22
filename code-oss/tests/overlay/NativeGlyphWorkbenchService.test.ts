import { describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import { AgentModeID } from '#glyph/protocol/index.js';
import type { GlyphContextAttachment } from '#glyph/protocol/connection/GlyphContextAttachment.js';
import { GlyphDesktopErrorCode } from '#glyph/protocol/GlyphDesktopError.js';
import type { GlyphAnnotation } from '#glyph/protocol/events/GlyphAnnotation.js';
import type { GlyphChatSummary } from '#glyph/protocol/events/GlyphChatSummary.js';
import type { GlyphDesktopSnapshot } from '#glyph/protocol/events/GlyphDesktopSnapshot.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#glyph/protocol/events/GlyphHostEvent.js';
import type { GlyphPlan } from '#glyph/protocol/events/GlyphPlan.js';
import { GlyphRunStatus, type GlyphRunProjection } from '#glyph/protocol/events/GlyphRunProjection.js';
import { GlyphWorkbenchCommandType, type GlyphWorkbenchCommand } from '#glyph/protocol/GlyphWorkbenchCommand.js';
import { GlyphFollowUpBehavior } from '#glyph/workbench/GlyphFollowUpBehavior.js';
import { GlyphReviewCommand } from '#glyph/workbench/GlyphReviewCommand.js';
import { GlyphTranscriptRole } from '#glyph/workbench/GlyphTranscriptEntry.js';
import { GlyphWorkbenchStatus } from '#glyph/workbench/GlyphWorkbenchState.js';
import { Emitter } from '#vs/base/common/event.js';
import { URI } from '#vs/base/common/uri.js';
import { GlyphContextController } from '#vs/workbench/contrib/glyph/browser/GlyphContextController.js';
import { GlyphContextError } from '#vs/workbench/contrib/glyph/browser/GlyphContextError.js';
import { GlyphEditorAdapter } from '#vs/workbench/contrib/glyph/browser/GlyphEditorAdapter.js';
import { GlyphPlanInput } from '#vs/workbench/contrib/glyph/browser/GlyphPlanEditor.js';
import { GlyphProposalEditor } from '#vs/workbench/contrib/glyph/browser/GlyphProposalEditor.js';
import { GlyphProposalReviewError } from '#vs/workbench/contrib/glyph/browser/GlyphProposalReviewError.js';
import { GlyphShellTerminals } from '#vs/workbench/contrib/glyph/browser/GlyphShellTerminals.js';
import { NativeGlyphWorkbenchService } from '#vs/workbench/contrib/glyph/browser/NativeGlyphWorkbenchService.js';
import { aGlyphChatSummary } from '#src/desktop/tests/fixtures/aGlyphChatSummary.ts';
import { aGlyphContextAttachment } from '#src/desktop/tests/fixtures/aGlyphContextAttachment.ts';
import { aGlyphPlan } from '#src/desktop/tests/fixtures/aGlyphPlan.ts';
import { aGlyphRunProjection } from '#src/desktop/tests/fixtures/aGlyphRunProjection.ts';

type Command = GlyphWorkbenchCommand & Record<string, unknown>;
type Handler = (command: Command, host: FakeHost) => unknown;

interface FakeHost {
  state: GlyphDesktopSnapshot;
  snapshot(): GlyphDesktopSnapshot;
  emit(event: unknown): void;
  respond(command: Command): void;
  disconnect(error: Error): void;
  connectHandler: (roots: readonly { name: string }[], trusted: boolean) => unknown;
  detachHandler: () => unknown;
  handler: Handler;
  attachment: string | undefined;
  readonly connect: Mock;
  readonly request: Mock;
  readonly detachWorkspace: Mock;
  readonly dispose: Mock;
  readonly handleEditorRequest: unknown;
}

const doubles = vi.hoisted(() => ({ hosts: [] as unknown[] }));

vi.mock('#vs/workbench/contrib/glyph/electron-browser/GlyphDesktopClient.js', async () => {
  const { Emitter: HoistedEmitter } = await import('#vs/base/common/event.js');
  const { GlyphHostEventType: HostEventType } = await import('#glyph/protocol/events/GlyphHostEvent.js');
  const { GlyphWorkbenchCommandType: WorkbenchCommandType } = await import('#glyph/protocol/GlyphWorkbenchCommand.js');
  class FakeGlyphDesktopClient {
    private readonly events = new HoistedEmitter<{ event: unknown }>();
    private readonly disconnects = new HoistedEmitter<Error>();
    readonly onDidReceiveEvent = this.events.event;
    readonly onDidDisconnect = this.disconnects.event;
    state = {
      accounts: [],
      models: [],
      chats: [],
      runs: [],
      proposals: [],
      ownerWindowId: '',
      readOnly: false,
      sequence: 0,
    };
    attachment: string | undefined;
    created = 0;
    handler: (command: never, host: FakeGlyphDesktopClient) => unknown = command => {
      this.respond(command);
    };
    connectHandler: (roots: unknown, trusted: boolean) => unknown = () => {};
    detachHandler: () => unknown = () => {};
    readonly connect = vi.fn(async (roots: unknown, trusted: boolean) => {
      await this.connectHandler(roots, trusted);
      const key = JSON.stringify([roots, trusted]);
      if (this.attachment === key) return;
      this.attachment = key;
      this.emit({ type: HostEventType.INITIAL_STATE, state: this.snapshot() });
    });
    readonly request = vi.fn(async (command: never) => {
      await this.handler(command, this);
    });
    readonly detachWorkspace = vi.fn(async () => {
      await this.detachHandler();
      this.attachment = undefined;
    });
    readonly dispose = vi.fn();
    constructor(readonly handleEditorRequest: unknown) {
      doubles.hosts.push(this);
    }
    snapshot() {
      return { ...this.state, chats: [...this.state.chats], runs: [...this.state.runs] };
    }
    emit(event: unknown): void {
      this.events.fire({ event });
    }
    disconnect(error: Error): void {
      this.disconnects.fire(error);
    }
    respond(command: Record<string, never>): void {
      switch (command.type) {
        case WorkbenchCommandType.SELECT_ACCOUNT:
          this.state = {
            ...this.state,
            selectedAccount: { provider: command.accountProvider, id: command.accountId },
            models: (this.state as { catalog?: Record<string, unknown> }).catalog?.[command.accountId] ?? [
              { slug: 'model', name: 'Model' },
            ],
          } as never;
          return;
        case WorkbenchCommandType.REQUEST_SNAPSHOT:
          this.emit({ type: HostEventType.INITIAL_STATE, state: this.snapshot() });
          return;
        case WorkbenchCommandType.CREATE_CHAT: {
          const summary = {
            id: `created-${++this.created}`,
            title: 'Created',
            accountProvider: command.accountProvider,
            accountId: command.accountId,
            modelSlug: command.model,
            updatedAt: '',
            turnCount: 0,
          };
          this.state = { ...this.state, chats: [...this.state.chats, summary] } as never;
          this.emit({ type: HostEventType.CHAT_UPDATED, chat: summary, creationId: command.creationId });
        }
      }
    }
  }
  return { GlyphDesktopClient: FakeGlyphDesktopClient };
});
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphShellTerminals.js', () => ({
  GlyphShellTerminals: class {
    readonly update = vi.fn();
    readonly open = vi.fn(async () => {});
    readonly dispose = vi.fn();
    constructor(readonly close: (shell: { id: string; chatId: string }) => void) {}
  },
}));
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphEditorAdapter.js', () => ({
  GlyphEditorAdapter: class {
    readonly invalidate = vi.fn();
    readonly rebindWorkspace = vi.fn();
    readonly handle = vi.fn(async () => ({}));
    readonly dispose = vi.fn();
  },
}));
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphContextController.js', () => ({
  GlyphContextController: class {
    readonly ide = { terminal: vi.fn() };
    readonly selectIdeContext = vi.fn(async () => [] as unknown[]);
    readonly attachSelection = vi.fn(async () => {});
    readonly captureResources = vi.fn(async () => [] as unknown[]);
    readonly rebindAttachment = vi.fn((value: object) => ({ ...value, sourceRevision: 'rebound' }));
    readonly dispose = vi.fn();
    constructor(
      readonly editor: unknown,
      readonly composer: () => unknown,
    ) {}
  },
}));
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphProposalEditor.js', () => ({
  GlyphProposalEditor: class {
    readonly changed = vi.fn();
    readonly acceptPreview = vi.fn();
    readonly revealAnnotation = vi.fn(async () => undefined);
    readonly executeCommand = vi.fn();
    readonly open = vi.fn(async () => {});
    readonly refresh = vi.fn(async () => {});
    readonly dispose = vi.fn();
    constructor(readonly host: Record<string, (...args: never[]) => unknown>) {}
  },
}));
vi.mock('#vs/workbench/contrib/glyph/browser/GlyphPlanEditor.js', () => ({
  GlyphPlanInput: class {
    constructor(
      readonly read: () => unknown,
      readonly actions: Record<string, (...args: never[]) => Promise<unknown>>,
      readonly onChange: (listener: () => void) => { dispose(): void },
    ) {}
  },
}));

function chat(id: string, extra: Partial<GlyphChatSummary> = {}): GlyphChatSummary {
  return aGlyphChatSummary({
    id,
    title: id,
    accountProvider: 'provider',
    accountId: 'account',
    modelSlug: 'model',
    updatedAt: '',
    turnCount: 0,
    ...extra,
  });
}

function run(
  chatId: string,
  runId: string,
  status = GlyphRunStatus.COMPLETED,
  extra: Partial<GlyphRunProjection> = {},
): GlyphRunProjection {
  return aGlyphRunProjection({ chatId, runId, status, text: `${runId} answer`, ...extra });
}

function attachment(extra: Partial<GlyphContextAttachment> = {}): GlyphContextAttachment {
  return aGlyphContextAttachment({
    uri: 'file:///project/a.ts',
    path: 'a.ts',
    text: 'source',
    contentRevision: 'revision',
    ...extra,
  });
}

function plan(extra: Partial<GlyphPlan> = {}): GlyphPlan {
  return aGlyphPlan({
    title: 'Approved work',
    markdown: 'Change source',
    todos: [
      { id: 'done', text: 'Done step', completed: true },
      { id: 'next', text: 'Next step', completed: false },
    ],
    ...extra,
  });
}

const account = { provider: 'provider', id: 'account', label: 'Account', connected: true, inferenceAccess: true };

function folder(name: string, scheme = 'file') {
  return { name, uri: scheme === 'file' ? URI.file(`/${name}`) : URI.from({ scheme, path: `/${name}` }) };
}

function gate() {
  let release: () => void = () => {};
  let enter: () => void = () => {};
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  return {
    released,
    entered,
    release,
    async hold() {
      enter();
      await released;
    },
  };
}

async function workbench({
  chats = [chat('alpha'), chat('beta')],
  runs = [] as GlyphRunProjection[],
  accounts = [] as unknown[],
  readOnly = false,
  extra = {},
  saved = {},
  folders = [folder('project')],
  trusted = true,
  settings = {},
  handler,
  connect = true,
}: {
  chats?: GlyphChatSummary[];
  runs?: GlyphRunProjection[];
  accounts?: unknown[];
  readOnly?: boolean;
  extra?: Partial<GlyphDesktopSnapshot> & { catalog?: Record<string, unknown> };
  saved?: Record<string, unknown>;
  folders?: ReturnType<typeof folder>[];
  trusted?: boolean;
  settings?: Record<string, unknown>;
  handler?: Handler;
  connect?: boolean;
} = {}) {
  doubles.hosts.length = 0;
  const storage = new Map(Object.entries({ 'glyph.selectedChat': 'alpha', ...saved }));
  const workspace = { id: 'workspace', configuration: undefined as URI | undefined, folders };
  const workspaceEvents = { folders: new Emitter<void>(), name: new Emitter<void>(), state: new Emitter<void>() };
  const profileEvents = new Emitter<void>();
  const profile = { currentProfile: { id: 'profile' }, onDidChangeCurrentProfile: profileEvents.event };
  const trustEvents = new Emitter<void>();
  const trust = { trusted, isWorkspaceTrusted: () => trust.trusted, onDidChangeTrust: trustEvents.event };
  const configurationEvents = new Emitter<{ affectsConfiguration: (key: string) => boolean }>();
  const created: unknown[] = [];
  const instantiation = {
    createInstance: (ctor: new (...args: unknown[]) => unknown, ...args: unknown[]) => {
      const instance = new ctor(...args);
      created.push(instance);
      return instance;
    },
  };
  const editors = { openEditor: vi.fn(async (..._args: unknown[]) => undefined) };
  const clipboard = { writeText: vi.fn(async () => {}) };
  const opener = { open: vi.fn(async () => true) };
  const configuration = {
    getValue: (key: string) => settings[key],
    onDidChangeConfiguration: configurationEvents.event,
  };
  const service = new NativeGlyphWorkbenchService(
    {
      get: (key: string) => storage.get(key),
      getObject: (key: string) => storage.get(key),
      store: (key: string, value: unknown) => storage.set(key, value),
    } as never,
    {
      getWorkspace: () => workspace,
      onDidChangeWorkspaceFolders: workspaceEvents.folders.event,
      onDidChangeWorkspaceName: workspaceEvents.name.event,
      onDidChangeWorkbenchState: workspaceEvents.state.event,
    } as never,
    trust as never,
    instantiation as never,
    profile as never,
    editors as never,
    clipboard as never,
    opener as never,
    configuration as never,
  );
  const host = doubles.hosts.at(-1) as FakeHost;
  host.state = {
    accounts,
    models: [],
    chats,
    runs,
    proposals: [],
    ownerWindowId: 'window',
    readOnly,
    sequence: 0,
    ...extra,
  } as GlyphDesktopSnapshot;
  if (handler) host.handler = handler;
  onTestFinished(() => {
    service.dispose();
    vi.useRealTimers();
  });
  if (connect) await service.connect();
  const instance = <T>(type: abstract new (...args: never[]) => T) => created.find(value => value instanceof type) as T;
  return {
    service,
    host,
    storage,
    workspace,
    editors,
    clipboard,
    opener,
    shells: instance(GlyphShellTerminals) as unknown as {
      close: (shell: { id: string; chatId: string }) => void;
      update: Mock;
      open: Mock;
    },
    editor: instance(GlyphEditorAdapter) as unknown as Record<string, Mock>,
    context: instance(GlyphContextController) as unknown as Record<string, Mock>,
    proposals: instance(GlyphProposalEditor) as unknown as Record<string, Mock> & {
      host: Record<string, (...args: never[]) => unknown>;
    },
    commands: () => host.request.mock.calls.map(([command]) => command as Command),
    types: () => host.request.mock.calls.map(([command]) => (command as Command).type),
    changeFolders(next: ReturnType<typeof folder>[], notify = true) {
      workspace.folders = next;
      if (notify) workspaceEvents.folders.fire();
    },
    renameWorkspace: () => {
      workspaceEvents.name.fire();
    },
    changeWorkbenchState: () => {
      workspaceEvents.state.fire();
    },
    changeProfile(id: string) {
      profile.currentProfile = { id };
      profileEvents.fire();
    },
    setTrust(value: boolean) {
      trust.trusted = value;
      trustEvents.fire();
    },
    changeConfiguration: (key: string) => {
      configurationEvents.fire({ affectsConfiguration: value => value === key });
    },
  };
}

function emit(host: FakeHost, event: GlyphHostEvent | Record<string, unknown>): void {
  host.emit(event);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

describe(NativeGlyphWorkbenchService, () => {
  it('wires editor and composer context callbacks into the desktop adapters', async () => {
    const { service, host, editor, context } = await workbench();
    const request = { requestId: 'read', type: 'read' };

    await (host.handleEditorRequest as (value: unknown) => Promise<unknown>)(request);

    expect(editor.handle).toHaveBeenCalledWith(request);
    expect((context.composer as unknown as () => unknown)()).toBe(service.composer);
    expect(service.ideContext).toBe((context as unknown as { ide: unknown }).ide);
  });

  describe('host events', () => {
    it('forwards proposal previews to the review editor without changing state', async () => {
      const { service, host, proposals } = await workbench();
      const listener = vi.fn();
      service.onDidChangeState(listener);
      const preview = { proposalId: 'proposal', fileId: 'file' };

      emit(host, { type: GlyphHostEventType.PROPOSAL_PREVIEW, preview });

      expect(proposals.acceptPreview).toHaveBeenCalledWith(preview);
      expect(listener).not.toHaveBeenCalled();
    });

    it('refreshes the review editor whenever state changes', async () => {
      const { host, proposals } = await workbench();
      proposals.changed.mockClear();

      emit(host, { type: GlyphHostEventType.USAGE, chatId: 'alpha', usage: { inputTokens: 1 } });

      expect(proposals.changed).toHaveBeenCalledTimes(1);
    });

    it('keeps background terminals in sync with the host', async () => {
      const { host, shells } = await workbench();
      const shell = {
        id: 'shell',
        chatId: 'alpha',
        command: 'npm test',
        workingDirectory: '/project',
        output: '',
        running: true,
      };

      emit(host, { type: GlyphHostEventType.SHELL_SESSIONS, shells: [shell] });

      expect(shells.update).toHaveBeenLastCalledWith([shell]);
    });

    it('applies host mode changes to the chat draft', async () => {
      const { service, host } = await workbench();
      const composer = service.composer;
      composer.setMode(AgentModeID.AGENT);

      emit(host, { type: GlyphHostEventType.CHAT_UPDATED, chat: chat('alpha', { mode: AgentModeID.PLAN }) });

      expect(composer.snapshot.document.options?.mode).toBe(AgentModeID.PLAN);
    });

    it('adopts the chat mode for an untouched draft', async () => {
      const { service } = await workbench({ chats: [chat('alpha', { mode: AgentModeID.PLAN })] });

      expect(service.composer.snapshot.document.options?.mode).toBe(AgentModeID.PLAN);
    });

    it('restores a chat draft with its captures and places the caret at its end', async () => {
      const { service, host } = await workbench();
      const composer = service.composer;
      const kept = attachment({ id: 'kept', path: 'a.ts' });
      const fresh = attachment({ path: 'b.ts', uri: 'file:///project/b.ts' });

      emit(host, {
        type: GlyphHostEventType.CHAT_RESTORED,
        chatId: 'alpha',
        runs: [],
        draft: { text: 'See @a.ts and @b.ts', attachments: [kept, fresh], options: { mode: AgentModeID.PLAN } },
      });

      expect(composer.snapshot.document).toEqual({
        parts: [
          { type: 'text', text: 'See ' },
          { type: 'attachment', attachment: kept },
          { type: 'text', text: ' and ' },
          { type: 'attachment', attachment: { ...fresh, id: expect.any(String) } },
        ],
        from: 11,
        to: 11,
        options: { mode: AgentModeID.PLAN },
      });
    });

    it('restores drafts without options and ignores drafts of chats without a composer', async () => {
      const { service, host } = await workbench();
      const composer = service.composer;

      emit(host, {
        type: GlyphHostEventType.CHAT_RESTORED,
        chatId: 'alpha',
        runs: [],
        draft: { text: 'Plain', attachments: [] },
      });
      emit(host, {
        type: GlyphHostEventType.CHAT_RESTORED,
        chatId: 'beta',
        runs: [],
        draft: { text: 'Elsewhere', attachments: [] },
      });

      expect(composer.snapshot.document).toEqual({
        parts: [{ type: 'text', text: 'Plain' }],
        from: 5,
        to: 5,
        options: {},
      });
      await service.openChat('beta');
      expect(service.composer.snapshot.draft).toBe('');
    });

    it('reports a host disconnect', async () => {
      const { service, host, editor } = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });

      host.disconnect(new Error('The host exited.'));

      expect(editor.invalidate).toHaveBeenCalled();
      expect(service.state.status).toBe(GlyphWorkbenchStatus.DISCONNECTED);
      expect(service.state.transcript.at(-1)).toEqual({
        id: 'host:0',
        role: GlyphTranscriptRole.DIAGNOSTIC,
        text: 'The host exited.',
      });
    });

    it('announces changes to the follow-up behavior', async () => {
      const { service, changeConfiguration } = await workbench();
      const listener = vi.fn();
      service.onDidChangeState(listener);

      changeConfiguration('glyph.chat.followUpBehavior');
      changeConfiguration('glyph.other');

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('followUpBehavior', () => {
    it('sends follow-ups immediately only when configured to', async () => {
      const immediate = await workbench({
        settings: { 'glyph.chat.followUpBehavior': GlyphFollowUpBehavior.SEND_IMMEDIATELY },
      });
      const queued = await workbench({ settings: { 'glyph.chat.followUpBehavior': 'unknown' } });

      expect(immediate.service.followUpBehavior).toBe(GlyphFollowUpBehavior.SEND_IMMEDIATELY);
      expect(queued.service.followUpBehavior).toBe(GlyphFollowUpBehavior.QUEUE);
    });
  });

  describe('state', () => {
    it('projects the selected chat’s runs into a transcript', async () => {
      const preview = { ...attachment(), revision: 'revision' };
      const usage = { inputTokens: 3 };
      const modeSwaps = [{ id: 'swap' }];
      const questionResponses = [{ id: 'response' }];
      const { service } = await workbench({
        runs: [
          run('alpha', 'one', GlyphRunStatus.COMPLETED, {
            userText: 'First',
            createdAt: 't1',
            checkpointTurnId: 'checkpoint',
            options: { turnId: 'turn-1' },
            attachments: [preview],
            steering: [{ id: 'steer', text: 'Faster' }] as never,
            modeSwaps: modeSwaps as never,
            questionResponses: questionResponses as never,
            usage: usage as never,
            terminalMessage: 'Stopped early.',
          }),
          run('alpha', 'two', GlyphRunStatus.COMPLETED, {
            userText: 'Shell finished',
            options: { turnId: 'shell-event:1' },
          }),
          run('alpha', 'three'),
          run('beta', 'other', GlyphRunStatus.COMPLETED, { userText: 'Elsewhere' }),
        ],
      });

      expect(service.state.transcript).toEqual([
        {
          id: 'turn-1:user',
          role: GlyphTranscriptRole.USER,
          text: 'First',
          createdAt: 't1',
          checkpointTurnId: 'checkpoint',
          options: { turnId: 'turn-1' },
          attachments: [preview],
        },
        { id: 'steer', text: 'Faster', role: GlyphTranscriptRole.USER, steering: true },
        {
          id: 'turn-1',
          role: GlyphTranscriptRole.ASSISTANT,
          text: 'one answer',
          modeSwaps,
          questionResponses,
          createdAt: 't1',
          checkpointTurnId: 'checkpoint',
          usage,
          progress: { reasoning: '', tools: [], status: GlyphRunStatus.COMPLETED },
        },
        { id: 'one:terminal', role: GlyphTranscriptRole.DIAGNOSTIC, text: 'Stopped early.' },
        {
          id: 'shell-event:1:user',
          role: GlyphTranscriptRole.DIAGNOSTIC,
          text: 'Shell finished',
          options: { turnId: 'shell-event:1' },
        },
        {
          id: 'shell-event:1',
          role: GlyphTranscriptRole.ASSISTANT,
          text: 'two answer',
          progress: { reasoning: '', tools: [], status: GlyphRunStatus.COMPLETED },
        },
        {
          id: 'three',
          role: GlyphTranscriptRole.ASSISTANT,
          text: 'three answer',
          progress: { reasoning: '', tools: [], status: GlyphRunStatus.COMPLETED },
        },
      ]);
    });

    it('hides checkpoints while a response is active', async () => {
      const { service } = await workbench({
        runs: [
          run('alpha', 'one', GlyphRunStatus.COMPLETED, { userText: 'First', checkpointTurnId: 'checkpoint' }),
          run('alpha', 'two', GlyphRunStatus.STREAMING),
        ],
      });

      expect(service.state.transcript.some(entry => 'checkpointTurnId' in entry)).toBe(false);
    });

    it('lists host diagnostics and usage', async () => {
      const { service, host } = await workbench();

      emit(host, { type: GlyphHostEventType.ERROR, error: { code: 'INTERNAL', message: 'Indexing failed.' } });
      emit(host, { type: GlyphHostEventType.USAGE, chatId: 'alpha', usage: { inputTokens: 9 } });

      expect(service.state.transcript).toEqual([
        { id: 'host:0', role: GlyphTranscriptRole.DIAGNOSTIC, text: 'Indexing failed.' },
      ]);
      expect(service.state.usage).toEqual({ alpha: { inputTokens: 9 } });
    });

    it('only lists tabs of known chats and the new chat draft', async () => {
      const { service } = await workbench({ saved: { 'glyph.openChatTabs': ['', 'alpha', 'gone'] } });

      expect(service.state.openChatIds).toEqual(['', 'alpha']);
    });

    it('keeps draft catalog choices separate from the host projection', async () => {
      const { service } = await workbench({
        extra: { models: [{ slug: 'host', name: 'Host' }] as never, selectedModel: 'host' },
      });

      expect(service.state.models).toEqual([]);
      expect(service.state).not.toHaveProperty('selectedModel');
      expect(service.state).not.toHaveProperty('selectedAccount');
    });

    it.each([
      [GlyphRunStatus.WAITING_FOR_QUESTION, GlyphWorkbenchStatus.WAITING_FOR_QUESTION],
      [GlyphRunStatus.WAITING_FOR_APPROVAL, GlyphWorkbenchStatus.WAITING_FOR_APPROVAL],
      [GlyphRunStatus.STREAMING, GlyphWorkbenchStatus.STREAMING],
      [GlyphRunStatus.COMPLETED, GlyphWorkbenchStatus.READY],
    ])('reports a %s response as %s', async (status, expected) => {
      const { service } = await workbench({ runs: [run('alpha', 'one', status)] });

      expect(service.state.status).toBe(expected);
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.attachIdeContext, () => {
    it('inserts the chosen IDE context into the draft', async () => {
      const { service, context } = await workbench();
      const capture = attachment();
      context.selectIdeContext.mockResolvedValue([capture]);

      await service.attachIdeContext();

      expect(service.composer.snapshot.document.parts).toEqual([{ type: 'attachment', attachment: capture }]);
    });

    it('rejects context chosen for a draft that changed meanwhile', async () => {
      const { service, context } = await workbench();
      context.selectIdeContext.mockImplementation(async () => {
        service.composer.setDraft('Changed');
        return [attachment()];
      });

      await expect(service.attachIdeContext()).rejects.toThrow(
        'The active draft changed during capture. Choose the context again.',
      );
    });

    it('rejects context chosen for a chat that is no longer selected', async () => {
      const { service, context } = await workbench();
      context.selectIdeContext.mockImplementation(async () => {
        await service.openChat('beta');
        return [attachment()];
      });

      await expect(service.attachIdeContext()).rejects.toThrow(
        'The active draft changed during capture. Choose the context again.',
      );
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.attachSelection, () => {
    it('attaches the editor selection', async () => {
      const { service, context } = await workbench();

      await service.attachSelection();

      expect(context.attachSelection).toHaveBeenCalled();
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.attachExplorerResources, () => {
    it('inserts explorer resources into the current draft', async () => {
      const { service, context } = await workbench();
      const capture = attachment();
      context.captureResources.mockResolvedValue([capture]);

      await service.attachExplorerResources(['file:///project/a.ts'], false);

      expect(context.captureResources).toHaveBeenCalledWith(['file:///project/a.ts']);
      expect(service.state.selectedChatId).toBe('alpha');
      expect(service.composer.snapshot.document.parts).toEqual([{ type: 'attachment', attachment: capture }]);
    });

    it('inserts explorer resources into an empty new chat', async () => {
      const { service, context } = await workbench();
      const capture = attachment();
      context.captureResources.mockResolvedValue([capture]);
      service.composer.setDraft('Alpha draft');

      await service.attachExplorerResources(['file:///project/a.ts'], true);

      expect(service.state.selectedChatId).toBeUndefined();
      expect(service.composer.snapshot.document.parts).toEqual([{ type: 'attachment', attachment: capture }]);
      await service.openChat('alpha');
      expect(service.composer.snapshot.draft).toBe('Alpha draft');
    });

    it('waits for a chat transition to finish', async () => {
      const opening = gate();
      const { service } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.OPEN_CHAT && command.chatId === 'beta') await opening.hold();
          host.respond(command);
        },
      });
      const pending = service.openChat('beta');
      await opening.entered;

      await expect(service.attachExplorerResources(['file:///project/a.ts'], false)).rejects.toThrow(
        'Wait for the current chat transition.',
      );
      opening.release();
      await pending;
    });

    it('rejects resources captured while the user navigated', async () => {
      const { service, context } = await workbench();
      context.captureResources.mockImplementation(async () => {
        void service.openChat('beta');
        return [attachment()];
      });

      await expect(service.attachExplorerResources(['file:///project/a.ts'], false)).rejects.toThrow(
        'The active draft changed during capture. Choose the context again.',
      );
      await vi.waitFor(() => {
        expect(service.state.selectedChatId).toBe('beta');
      });
    });

    it('rejects resources captured while a message was being sent', async () => {
      const sending = gate();
      const { service, context } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SEND) await sending.hold();
          host.respond(command);
        },
      });
      let send: Promise<void> | undefined;
      context.captureResources.mockImplementation(async () => {
        send = service.send('Hello');
        await sending.entered;
        return [attachment()];
      });

      await expect(service.attachExplorerResources(['file:///project/a.ts'], false)).rejects.toThrow(
        'Wait for the current chat transition.',
      );
      sending.release();
      await send;
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.copyText, () => {
    it('copies text to the clipboard', async () => {
      const { service, clipboard } = await workbench();

      await service.copyText('Copied');

      expect(clipboard.writeText).toHaveBeenCalledWith('Copied');
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.openLink, () => {
    it('opens web links externally by default', async () => {
      const { service, opener, editors } = await workbench();

      await service.openLink('HTTPS://example.com/article');

      expect(opener.open).toHaveBeenCalledWith(expect.objectContaining({ authority: 'example.com' }), {
        allowCommands: false,
        openExternal: true,
      });
      expect(String(vi.mocked(opener.open).mock.lastCall![0])).toBe('https://example.com/article');
      expect(editors.openEditor).not.toHaveBeenCalled();
    });

    it('opens web links in the integrated browser when preferred', async () => {
      const { service, opener, editors } = await workbench({
        settings: { 'glyph.preferOpeningWebLinksInGlyph': true },
      });

      await service.openLink('http://example.com/');

      expect(editors.openEditor).toHaveBeenCalledWith({
        resource: expect.anything(),
        options: { pinned: true, viewState: { url: 'http://example.com/' } },
      });
      expect(opener.open).not.toHaveBeenCalled();
    });

    it('refuses web links with embedded credentials', async () => {
      const { service } = await workbench();

      for (const link of ['https://user@example.com', 'https://:secret@example.com'])
        await expect(service.openLink(link)).rejects.toThrow('Web links cannot contain embedded credentials.');
    });

    it('opens workspace paths without their line anchors', async () => {
      const { service, editors } = await workbench();

      await service.openLink('src/a.ts#L10-L20');
      await service.openLink('src/b.ts#L3');

      expect(editors.openEditor.mock.calls.map(([input]) => String((input as { resource: URI }).resource))).toEqual([
        'file:///project/src/a.ts',
        'file:///project/src/b.ts',
      ]);
    });

    it('refuses paths outside the workspace', async () => {
      const { service, editors } = await workbench();

      for (const link of ['mailto:someone', '/etc/passwd', '../secret', 'src/../../secret', 'src/..'])
        await expect(service.openLink(link)).rejects.toEqual(
          new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'This link is not a workspace path.'),
        );
      expect(editors.openEditor).not.toHaveBeenCalled();
    });

    it('refuses workspace paths without a workspace folder', async () => {
      const { service } = await workbench({ folders: [], connect: false });

      await expect(service.openLink('src/a.ts')).rejects.toThrow('This link is not a workspace path.');
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.selectMode, () => {
    it('changes the mode of the selected chat', async () => {
      const { service, commands } = await workbench();

      await service.selectMode(AgentModeID.PLAN);

      expect(commands().at(-1)).toEqual({
        type: GlyphWorkbenchCommandType.SET_CHAT_MODE,
        chatId: 'alpha',
        mode: AgentModeID.PLAN,
      });
      expect(service.composer.snapshot.document.options?.mode).toBe(AgentModeID.PLAN);
    });

    it('only changes the draft mode of a new chat', async () => {
      const { service, types } = await workbench({ saved: { 'glyph.selectedChat': '' } });

      await service.selectMode(AgentModeID.PLAN);

      expect(types()).not.toContain(GlyphWorkbenchCommandType.SET_CHAT_MODE);
      expect(service.composer.snapshot.document.options?.mode).toBe(AgentModeID.PLAN);
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.viewPlan, () => {
    async function planInput(test: Awaited<ReturnType<typeof workbench>>, chatId: string, value: GlyphPlan) {
      await test.service.viewPlan(chatId, value);
      const [input, options] = test.editors.openEditor.mock.lastCall!;
      expect(input).toBeInstanceOf(GlyphPlanInput);
      expect(options).toEqual({ pinned: true });
      return input as {
        read: () => Record<string, unknown>;
        actions: Record<string, (...args: never[]) => Promise<unknown>>;
        onChange: (listener: () => void) => { dispose(): void };
      };
    }

    it('shows the latest plan revision with its model and agents', async () => {
      const current = plan({
        revision: 2,
        agents: [
          { chatId: 'beta', role: 'Builder' },
          { chatId: 'gone', role: 'Reviewer' },
        ],
      });
      const test = await workbench({ chats: [chat('alpha', { plans: [plan(), current] }), chat('beta')] });

      const input = await planInput(test, 'alpha', plan());

      expect(input.read()).toEqual({
        plan: current,
        modelLabel: 'model',
        disabled: false,
        agents: [
          { chatId: 'beta', role: 'Builder', title: 'beta' },
          { chatId: 'gone', role: 'Reviewer', title: 'Chat unavailable' },
        ],
      });
    });

    it('shows the given plan when its chat is unavailable', async () => {
      const test = await workbench();
      const shown = plan();

      const input = await planInput(test, 'gone', shown);

      expect(input.read()).toEqual({ plan: shown, modelLabel: undefined, disabled: false, agents: [] });
    });

    it('names the chat model from the catalog', async () => {
      const test = await workbench({
        saved: { 'glyph.selectedChat': '' },
        accounts: [account],
        chats: [chat('alpha', { plans: [plan()] })],
      });
      await vi.waitFor(() => {
        expect(test.service.state.selectedModel).toBe('model');
      });

      const input = await planInput(test, 'alpha', plan());

      expect(input.read()).toMatchObject({ modelLabel: 'Model' });
    });

    it('disables the plan while its chat responds or the session is read-only', async () => {
      const active = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });
      const readOnly = await workbench({ readOnly: true });

      expect((await planInput(active, 'alpha', plan())).read()).toMatchObject({ disabled: true });
      expect((await planInput(readOnly, 'alpha', plan())).read()).toMatchObject({ disabled: true });
    });

    it('lets the plan editor update the plan, open chats and links, copy text and follow changes', async () => {
      const test = await workbench({ chats: [chat('alpha', { plans: [plan()] }), chat('beta')] });
      const input = await planInput(test, 'alpha', plan());
      const updated = plan({ markdown: 'Changed' });
      const listener = vi.fn();

      await input.actions.update(updated as never);
      await input.actions.openChat('beta' as never);
      await input.actions.openLink('https://example.com' as never);
      await input.actions.copyText('Copied' as never);
      const subscription = input.onChange(listener);
      test.service.newChat();
      subscription.dispose();

      expect(test.commands()).toContainEqual({
        type: GlyphWorkbenchCommandType.UPDATE_PLAN,
        chatId: 'alpha',
        plan: updated,
      });
      expect(test.storage.get('glyph.selectedChat')).toBe('');
      expect(test.opener.open).toHaveBeenCalled();
      expect(test.clipboard.writeText).toHaveBeenCalledWith('Copied');
      expect(listener).toHaveBeenCalled();
    });

    it('reopens the plan from an annotation that refers to it', async () => {
      const test = await workbench({ chats: [chat('alpha', { plans: [plan()] })] });
      await planInput(test, 'alpha', plan());

      await expect(test.service.composer.revealAnnotation({ sourceId: 'plan' } as GlyphAnnotation)).resolves.toBe(
        undefined,
      );

      expect(test.editors.openEditor).toHaveBeenCalledTimes(2);
    });

    it('builds the current plan revision from the plan editor', async () => {
      const test = await workbench({ chats: [chat('alpha', { plans: [plan()] })] });
      const input = await planInput(test, 'alpha', plan());

      await input.actions.build(true as never);

      expect(test.commands()).toContainEqual(
        expect.objectContaining({ type: GlyphWorkbenchCommandType.LINK_PLAN, targetChatId: 'created-1' }),
      );
    });

    it('starts a reviewer chat for the plan', async () => {
      const test = await workbench({ chats: [chat('alpha', { plans: [plan()] })] });
      const input = await planInput(test, 'alpha', plan());

      await input.actions.newAgent();

      expect(test.commands().slice(-2)).toEqual([
        {
          type: GlyphWorkbenchCommandType.CREATE_CHAT,
          creationId: expect.any(String),
          accountProvider: 'provider',
          accountId: 'account',
          model: 'model',
        },
        {
          type: GlyphWorkbenchCommandType.LINK_PLAN,
          chatId: 'alpha',
          planId: 'plan',
          targetChatId: 'created-1',
          role: 'Reviewer',
        },
      ]);
      expect(test.service.state.selectedChatId).toBe('created-1');
      expect(test.service.composer.snapshot.document.options?.mode).toBe(AgentModeID.PLAN);
      expect(test.service.composer.snapshot.draft).toBe(
        'Review this plan: Approved work (plan plan, revision 1).\n\nChange source\n\nTodos:\n- [x] Done step\n- [ ] Next step',
      );
      expect(test.service.composer.snapshot.focus).toBe(1);
    });

    it('refuses reviewer chats for unavailable plan chats', async () => {
      const test = await workbench();
      const input = await planInput(test, 'gone', plan());

      await expect(input.actions.newAgent()).rejects.toEqual(
        new GlyphContextError(GlyphDesktopErrorCode.NOT_FOUND, 'The plan chat is unavailable.'),
      );
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.buildPlan, () => {
    it('sends the approved plan in agent mode from its chat', async () => {
      const { service, commands } = await workbench({
        chats: [chat('alpha', { plans: [plan()] })],
        runs: [run('alpha', 'earlier')],
      });
      service.composer.setDraft('Context');

      await service.buildPlan('alpha', plan());

      expect(commands().slice(-4)).toEqual([
        { type: GlyphWorkbenchCommandType.SET_CHAT_MODE, chatId: 'alpha', mode: AgentModeID.AGENT },
        {
          type: GlyphWorkbenchCommandType.LINK_PLAN,
          chatId: 'alpha',
          planId: 'plan',
          targetChatId: 'alpha',
          role: 'Builder',
        },
        { type: GlyphWorkbenchCommandType.SET_CHAT_MODE, chatId: 'alpha', mode: AgentModeID.AGENT },
        expect.objectContaining({
          type: GlyphWorkbenchCommandType.SEND,
          chatId: 'alpha',
          text: 'Context\n\nBuild this approved plan: Approved work (plan plan, revision 1).\n\nChange source\n\nTodos:\n- [x] Done step\n- [ ] Next step',
          options: expect.objectContaining({ mode: AgentModeID.AGENT }),
        }),
      ]);
    });

    it('opens the plan chat before building', async () => {
      const { service, types } = await workbench({
        saved: { 'glyph.selectedChat': 'beta' },
        chats: [chat('alpha', { plans: [plan()] }), chat('beta')],
        runs: [run('alpha', 'earlier'), run('beta', 'earlier')],
      });

      await service.buildPlan('alpha', plan());

      expect(service.state.selectedChatId).toBe('alpha');
      expect(types().slice(-5)).toEqual([
        GlyphWorkbenchCommandType.OPEN_CHAT,
        GlyphWorkbenchCommandType.SET_CHAT_MODE,
        GlyphWorkbenchCommandType.LINK_PLAN,
        GlyphWorkbenchCommandType.SET_CHAT_MODE,
        GlyphWorkbenchCommandType.SEND,
      ]);
    });

    it('builds in a new chat', async () => {
      const { service, commands } = await workbench({ chats: [chat('alpha', { plans: [plan()] })] });

      await service.buildPlan('alpha', plan(), true);

      expect(service.state.selectedChatId).toBe('created-1');
      expect(commands().filter(command => command.type === GlyphWorkbenchCommandType.SEND)).toEqual([
        expect.objectContaining({ chatId: 'created-1' }),
      ]);
    });

    it('refuses outdated or missing plans', async () => {
      const { service } = await workbench({ chats: [chat('alpha', { plans: [plan({ revision: 2 })] }), chat('beta')] });

      for (const [chatId, value] of [
        ['alpha', plan()],
        ['beta', plan()],
      ] as const)
        await expect(service.buildPlan(chatId, value)).rejects.toEqual(
          new GlyphContextError(
            GlyphDesktopErrorCode.NOT_FOUND,
            'The plan changed. Review its current revision before building.',
          ),
        );
    });

    it('stops when the plan chat cannot be opened', async () => {
      const { service, types } = await workbench({
        saved: { 'glyph.selectedChat': 'beta' },
        chats: [chat('alpha', { plans: [plan()] }), chat('beta')],
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.OPEN_CHAT && command.chatId === 'alpha')
            throw new Error('Could not open the chat.');
          host.respond(command);
        },
      });

      await expect(service.buildPlan('alpha', plan())).rejects.toThrow('Could not open the chat.');
      expect(types()).not.toContain(GlyphWorkbenchCommandType.LINK_PLAN);
    });

    it('stops when the user navigates elsewhere while opening the plan chat', async () => {
      const opening = gate();
      const { service } = await workbench({
        saved: { 'glyph.selectedChat': 'beta' },
        chats: [chat('alpha', { plans: [plan()] }), chat('beta')],
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.OPEN_CHAT && command.chatId === 'alpha') await opening.hold();
          host.respond(command);
        },
      });

      const building = service.buildPlan('alpha', plan());
      await opening.entered;
      await service.openChat('beta');
      opening.release();

      await expect(building).rejects.toThrow('The plan chat could not be selected. Try building again.');
    });

    it('keeps the plan in the draft while an immediate send is stopping a response', async () => {
      const sending = gate();
      const { service } = await workbench({
        chats: [chat('alpha', { plans: [plan()] })],
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SEND) await sending.hold();
          host.respond(command);
        },
      });
      const immediate = service.sendImmediately('Now');
      await sending.entered;

      await service.buildPlan('alpha', plan());

      expect(service.composer.snapshot.error).toBe('Waiting for the current response to stop.');
      expect(service.composer.snapshot.draft).toContain('Build this approved plan');
      sending.release();
      await immediate;
    });

    it('stops when the workspace changes while building', async () => {
      const linking = gate();
      const test = await workbench({
        chats: [chat('alpha', { plans: [plan()] })],
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SET_CHAT_MODE) await linking.hold();
          host.respond(command);
        },
      });
      const building = test.service.buildPlan('alpha', plan());
      await linking.entered;

      test.changeFolders([folder('project'), folder('docs')]);
      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toMatch(/^Workspace updated/u);
      });
      linking.release();

      await expect(building).rejects.toThrow('Workspace changed while the action was pending. Please try again.');
      expect(test.types()).not.toContain(GlyphWorkbenchCommandType.LINK_PLAN);
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.send, () => {
    it('sends a trimmed prompt with its captures, mode and mode switch policy', async () => {
      const capture = attachment();
      const { service, commands } = await workbench({
        settings: { 'glyph.modeSwitch.autoApprove': true, 'glyph.modeSwitch.timeoutSeconds': 20 },
      });

      await service.send('  Hello  ', [capture], { mode: AgentModeID.PLAN });

      expect(commands().slice(-2)).toEqual([
        { type: GlyphWorkbenchCommandType.SET_CHAT_MODE, chatId: 'alpha', mode: AgentModeID.PLAN },
        {
          type: GlyphWorkbenchCommandType.SEND,
          modeSwapPolicy: { autoApprove: true, timeoutSeconds: 20 },
          chatId: 'alpha',
          runId: expect.any(String),
          text: 'Hello',
          attachments: [capture],
          options: { mode: AgentModeID.PLAN },
        },
      ]);
    });

    it('does not switch to the mode the chat already uses', async () => {
      const { service, types } = await workbench({ chats: [chat('alpha', { mode: AgentModeID.PLAN })] });

      await service.send('Hello', [], { mode: AgentModeID.PLAN });

      expect(types()).not.toContain(GlyphWorkbenchCommandType.SET_CHAT_MODE);
    });

    it('shows the prompt as streaming until the host reports its run', async () => {
      const { service, host, commands } = await workbench();

      await service.send('Hello');
      const runId = commands().at(-1)!.runId as string;

      expect(service.state.status).toBe(GlyphWorkbenchStatus.STREAMING);
      expect(service.state.transcript).toEqual([
        { id: `${runId}:user`, role: GlyphTranscriptRole.USER, text: 'Hello' },
      ]);
      emit(host, { type: GlyphHostEventType.RUN_STATE, run: run('alpha', runId, GlyphRunStatus.COMPLETED) });
      expect(service.state.status).toBe(GlyphWorkbenchStatus.READY);
      expect(service.state.transcript.map(entry => [entry.id, entry.text])).toEqual([
        [`${runId}:user`, 'Hello'],
        [runId, `${runId} answer`],
      ]);
    });

    it('ignores runs it is not waiting for', async () => {
      const { service, host } = await workbench();
      await service.send('Hello');

      emit(host, { type: GlyphHostEventType.RUN_STATE, run: run('alpha', 'other', GlyphRunStatus.COMPLETED) });

      expect(service.state.status).toBe(GlyphWorkbenchStatus.STREAMING);
    });

    it('limits the captured context', async () => {
      const { service } = await workbench();
      const error = new GlyphContextError(
        GlyphDesktopErrorCode.READ_LIMIT_EXCEEDED,
        'Reduce the selected context to at most 32 attachments and 2 MiB before sending.',
      );

      await expect(
        service.send(
          'Hello',
          Array.from({ length: 33 }, () => attachment({ text: '' })),
        ),
      ).rejects.toEqual(error);
      await expect(service.send('Hello', [attachment({ text: 'x'.repeat(2 * 1024 * 1024 + 1) })])).rejects.toEqual(
        error,
      );
    });

    it('refuses unavailable captures', async () => {
      const { service } = await workbench();

      await expect(service.send('Hello', [attachment({ unavailable: 'The file moved.' })])).rejects.toThrow(
        'The file moved.',
      );
    });

    it('refuses empty prompts and prompts for a busy chat', async () => {
      const sending = gate();
      const { service } = await workbench({
        runs: [run('beta', 'live', GlyphRunStatus.STREAMING)],
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SEND) await sending.hold();
          host.respond(command);
        },
      });
      const busy = 'The chat is busy. Queue the message or send it immediately.';

      await expect(service.send('   ')).rejects.toThrow(busy);
      const first = service.send('First');
      await sending.entered;
      await expect(service.send('Second')).rejects.toThrow(busy);
      sending.release();
      await first;
      await expect(service.send('Third')).rejects.toThrow(busy);
      await service.openChat('beta');
      await expect(service.send('Fourth')).rejects.toThrow(busy);
    });

    it('refuses to send from a read-only window and reports why', async () => {
      const { service } = await workbench({ readOnly: true });

      await expect(service.send('Hello')).rejects.toThrow('Another window owns this workspace’s Glyph session.');
      expect(service.state.transcript.at(-1)).toMatchObject({
        role: GlyphTranscriptRole.DIAGNOSTIC,
        text: 'Another window owns this workspace’s Glyph session.',
      });
    });

    it('reports a rejected message and stops showing it as pending', async () => {
      const { service } = await workbench({
        handler: (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SEND) throw new Error('Rejected.');
          host.respond(command);
        },
      });

      await expect(service.send('Hello')).rejects.toThrow('Rejected.');
      expect(service.state.status).toBe(GlyphWorkbenchStatus.READY);
      expect(service.state.transcript).toEqual([
        { id: expect.any(String), role: GlyphTranscriptRole.DIAGNOSTIC, text: 'Rejected.' },
      ]);
    });

    it('creates a chat for a new chat draft', async () => {
      const { service, commands } = await workbench({
        saved: { 'glyph.selectedChat': '', 'glyph.openChatTabs': ['', 'alpha'] },
        accounts: [account],
      });
      service.composer.setDraft('Draft');

      await service.send('Hello');

      expect(service.state.selectedChatId).toBe('created-1');
      expect(service.state.openChatIds).toEqual(['created-1', 'alpha']);
      expect(service.composer.snapshot.draft).toBe('Draft');
      expect(commands().slice(-2)).toEqual([
        expect.objectContaining({ type: GlyphWorkbenchCommandType.CREATE_CHAT, model: 'model' }),
        expect.objectContaining({ type: GlyphWorkbenchCommandType.SEND, chatId: 'created-1' }),
      ]);
    });

    it('requires an account and model for a new chat', async () => {
      const unsigned = await workbench({ saved: { 'glyph.selectedChat': '' } });
      const empty = await workbench({
        saved: { 'glyph.selectedChat': '' },
        accounts: [account],
        extra: { catalog: { account: [] } },
      });

      await expect(unsigned.service.send('Hello')).rejects.toThrow(
        'Sign in to a Glyph account with inference access before sending a message.',
      );
      await expect(empty.service.send('Hello')).rejects.toThrow('No models are available for this account.');
      empty.service.newChat();
      await expect(empty.service.send('Hello')).rejects.toThrow('No models are available for the selected account.');
    });

    it('requires a chat when the new chat disappears before sending', async () => {
      const { service } = await workbench({
        saved: { 'glyph.selectedChat': '' },
        accounts: [account],
        handler: (command, host) => {
          host.respond(command);
          if (command.type === GlyphWorkbenchCommandType.CREATE_CHAT)
            host.emit({ type: GlyphHostEventType.INITIAL_STATE, state: { ...host.state, chats: [] } });
        },
      });

      await expect(service.send('Hello')).rejects.toThrow('Create or open a chat before sending.');
    });

    it('rebinds file captures after the workspace changed', async () => {
      const test = await workbench();
      test.changeFolders([folder('project'), folder('docs')]);
      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toMatch(/^Workspace updated/u);
      });
      const file = attachment();
      const untitled = attachment({ uri: 'untitled:Untitled-1', path: 'Untitled-1' });

      await test.service.send('Hello', [file, untitled]);

      expect(test.commands().at(-1)).toMatchObject({ attachments: [{ ...file, sourceRevision: 'rebound' }, untitled] });
    });

    it('waits while an immediate send is stopping a response', async () => {
      const sending = gate();
      const { service } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SEND) await sending.hold();
          host.respond(command);
        },
      });
      const immediate = service.sendImmediately('Now');
      await sending.entered;

      await expect(service.send('Later')).rejects.toThrow('Waiting for the current response to stop.');
      await expect(service.sendImmediately('Again')).rejects.toThrow('A chat transition is already in progress.');
      sending.release();
      await immediate;
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.sendImmediately, () => {
    it('sends right away without an active response', async () => {
      const { service, types } = await workbench();

      await service.sendImmediately('Now');

      expect(types().at(-1)).toBe(GlyphWorkbenchCommandType.SEND);
      expect(types()).not.toContain(GlyphWorkbenchCommandType.CANCEL_RUN);
    });

    it('stops the active response before sending', async () => {
      const { service, commands } = await workbench({
        runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)],
        handler: (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.CANCEL_RUN)
            host.emit({ type: GlyphHostEventType.RUN_STATE, run: run('alpha', 'live', GlyphRunStatus.CANCELLED) });
          host.respond(command);
        },
      });

      await service.sendImmediately('Now', [], {});

      expect(commands().slice(-2)).toEqual([
        { type: GlyphWorkbenchCommandType.CANCEL_RUN, chatId: 'alpha', runId: 'live' },
        expect.objectContaining({ type: GlyphWorkbenchCommandType.SEND, text: 'Now' }),
      ]);
    });

    it('waits for the response to stop', async () => {
      const { service, host, types } = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });

      const sending = service.sendImmediately('Now');
      await vi.waitFor(() => {
        expect(types()).toContain(GlyphWorkbenchCommandType.CANCEL_RUN);
      });
      emit(host, { type: GlyphHostEventType.USAGE, chatId: 'alpha', usage: {} });
      expect(types()).not.toContain(GlyphWorkbenchCommandType.SEND);
      emit(host, { type: GlyphHostEventType.RUN_STATE, run: run('alpha', 'live', GlyphRunStatus.CANCELLED) });
      await sending;

      expect(types().at(-1)).toBe(GlyphWorkbenchCommandType.SEND);
    });

    it('keeps the message when the host disconnects while stopping', async () => {
      const { service, host, types } = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });

      const sending = service.sendImmediately('Now');
      await vi.waitFor(() => {
        expect(types()).toContain(GlyphWorkbenchCommandType.CANCEL_RUN);
      });
      host.disconnect(new Error('Host exited.'));

      await expect(sending).rejects.toThrow('Glyph disconnected while stopping the response.');
      expect(types()).not.toContain(GlyphWorkbenchCommandType.SEND);
    });

    it('keeps the message when the session is retired while stopping', async () => {
      const test = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });

      const sending = test.service.sendImmediately('Now');
      await vi.waitFor(() => {
        expect(test.types()).toContain(GlyphWorkbenchCommandType.CANCEL_RUN);
      });
      test.changeProfile('other');

      await expect(sending).rejects.toThrow('Glyph disconnected while stopping the response.');
    });

    it('gives up when the response does not stop in time', async () => {
      vi.useFakeTimers();
      const { service } = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });

      const sending = service.sendImmediately('Now');
      const rejection = expect(sending).rejects.toThrow('The response has not stopped yet. Your message was retained.');
      await vi.advanceTimersByTimeAsync(30_000);

      await rejection;
    });

    it('refuses while navigating', async () => {
      const opening = gate();
      const { service } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.OPEN_CHAT && command.chatId === 'beta') await opening.hold();
          host.respond(command);
        },
      });
      const pending = service.openChat('beta');
      await opening.entered;

      await expect(service.sendImmediately('Now')).rejects.toThrow('A chat transition is already in progress.');
      opening.release();
      await pending;
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.steer, () => {
    it('steers the active response', async () => {
      const { service, commands } = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });

      await service.steer('  Faster  ');

      expect(commands().at(-1)).toEqual({
        type: GlyphWorkbenchCommandType.STEER,
        chatId: 'alpha',
        runId: 'live',
        messageId: expect.any(String),
        text: 'Faster',
        attachments: [],
        options: {},
      });
    });

    it('refuses unavailable captures', async () => {
      const { service } = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });

      await expect(
        service.steer('Faster', [attachment(), attachment({ unavailable: 'The file moved.' })], {}),
      ).rejects.toThrow('The file moved.');
    });

    it('requires an active response', async () => {
      const { service } = await workbench({ runs: [run('beta', 'live', GlyphRunStatus.STREAMING)] });

      await expect(service.steer('Faster')).rejects.toThrow('There is no active response to steer.');
    });

    it('refuses while navigating', async () => {
      const opening = gate();
      const { service } = await workbench({
        runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)],
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.OPEN_CHAT && command.chatId === 'beta') await opening.hold();
          host.respond(command);
        },
      });
      const pending = service.openChat('beta');
      await opening.entered;

      await expect(service.steer('Faster')).rejects.toThrow('There is no active response to steer.');
      opening.release();
      await pending;
    });

    it('refuses in a read-only window', async () => {
      const { service } = await workbench({ readOnly: true, runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });

      await expect(service.steer('Faster')).rejects.toThrow('Another window owns this workspace’s Glyph session.');
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.startAgentReview, () => {
    const review = { reviewId: 'review' } as never;

    it('reviews with the selected chat’s model', async () => {
      const { service, commands } = await workbench({ chats: [chat('alpha', { modelSlug: 'deep' })] });

      await service.startAgentReview(review);

      expect(commands().at(-1)).toEqual({
        type: GlyphWorkbenchCommandType.START_AGENT_REVIEW,
        review,
        model: { accountProvider: 'provider', accountId: 'account', model: 'deep' },
      });
    });

    it('reviews with the new chat’s account and model', async () => {
      const { service, commands } = await workbench({ saved: { 'glyph.selectedChat': '' }, accounts: [account] });
      await vi.waitFor(() => {
        expect(service.state.selectedModel).toBe('model');
      });

      await service.startAgentReview(review);

      expect(commands().at(-1)).toMatchObject({
        model: { accountProvider: 'provider', accountId: 'account', model: 'model' },
      });
    });

    it('requires an account and model', async () => {
      const { service } = await workbench({ saved: { 'glyph.selectedChat': '' } });

      await expect(service.startAgentReview(review)).rejects.toThrow('Choose an account and model before reviewing.');
    });
  });

  describe('host commands', () => {
    it('forwards review, run, shell, question and approval commands', async () => {
      const { service, commands } = await workbench();
      const decision = { approved: true } as never;

      await service.cancelAgentReview('review');
      await service.dismissAgentReviewFinding('review', 'finding');
      await service.cancelRun('alpha', 'run');
      await service.restoreCheckpoint('alpha', 'turn');
      await service.writeShellInput('alpha', 'shell', 'ls', true);
      await service.stopShell('alpha', 'shell');
      await service.answerQuestion('alpha', 'run', 'question', 'yes');
      await service.decideApproval('alpha', 'run', 'approval', decision);

      expect(commands().slice(-8)).toEqual([
        { type: GlyphWorkbenchCommandType.CANCEL_AGENT_REVIEW, reviewId: 'review' },
        { type: GlyphWorkbenchCommandType.DISMISS_AGENT_REVIEW_FINDING, reviewId: 'review', findingId: 'finding' },
        { type: GlyphWorkbenchCommandType.CANCEL_RUN, chatId: 'alpha', runId: 'run' },
        { type: GlyphWorkbenchCommandType.RESTORE_CHECKPOINT, chatId: 'alpha', turnId: 'turn' },
        {
          type: GlyphWorkbenchCommandType.WRITE_SHELL_INPUT,
          chatId: 'alpha',
          sessionId: 'shell',
          input: 'ls',
          appendNewline: true,
        },
        { type: GlyphWorkbenchCommandType.STOP_SHELL_SESSION, chatId: 'alpha', sessionId: 'shell' },
        {
          type: GlyphWorkbenchCommandType.ANSWER_QUESTION,
          chatId: 'alpha',
          runId: 'run',
          questionId: 'question',
          answer: 'yes',
        },
        {
          type: GlyphWorkbenchCommandType.DECIDE_APPROVAL,
          chatId: 'alpha',
          runId: 'run',
          approvalId: 'approval',
          decision,
        },
      ]);
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.cancel, () => {
    it('cancels the active response and pauses queued messages', async () => {
      const { service, commands } = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });
      service.composer.setDraft('Later');
      service.composer.enqueueDraft();

      service.cancel();

      await vi.waitFor(() => {
        expect(commands().at(-1)).toEqual({
          type: GlyphWorkbenchCommandType.CANCEL_RUN,
          chatId: 'alpha',
          runId: 'live',
        });
      });
      expect(service.composer.snapshot.queuePaused).toBe(true);
    });

    it('cancels a response the host has not started yet', async () => {
      const sending = gate();
      const { service, commands } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SEND) await sending.hold();
          host.respond(command);
        },
      });
      const send = service.send('Hello');
      await sending.entered;
      const runId = commands().at(-1)!.runId;

      service.cancel();

      await vi.waitFor(() => {
        expect(commands().at(-1)).toMatchObject({ type: GlyphWorkbenchCommandType.CANCEL_RUN, runId });
      });
      sending.release();
      await send;
    });

    it('does nothing without a response', async () => {
      const chatTest = await workbench();
      const draftTest = await workbench({ saved: { 'glyph.selectedChat': '' } });

      chatTest.service.cancel();
      draftTest.service.cancel();
      await flush();

      expect(chatTest.types()).not.toContain(GlyphWorkbenchCommandType.CANCEL_RUN);
      expect(draftTest.types()).not.toContain(GlyphWorkbenchCommandType.CANCEL_RUN);
    });

    it('reports cancellation failures', async () => {
      const { service } = await workbench({
        runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)],
        handler: (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.CANCEL_RUN) throw new Error('Too late.');
          host.respond(command);
        },
      });

      service.cancel();

      await vi.waitFor(() => {
        expect(service.state.transcript.at(-1)?.text).toBe('Too late.');
      });
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.selectAccount, () => {
    it('keeps the account of a saved chat', async () => {
      const { service, types } = await workbench();

      await service.selectAccount('provider', 'other');

      expect(types()).not.toContain(GlyphWorkbenchCommandType.SELECT_ACCOUNT);
      expect(service.state.selectedAccount).toBeUndefined();
    });

    it('loads the models of the new chat account', async () => {
      const { service, commands } = await workbench({
        saved: { 'glyph.selectedChat': '' },
        extra: { catalog: { other: [{ slug: 'fast', name: 'Fast' }] } },
      });

      const selecting = service.selectAccount('provider', 'other');
      expect(service.state.catalogPending).toBe(true);
      await selecting;

      expect(commands().slice(-2)).toEqual([
        { type: GlyphWorkbenchCommandType.SELECT_ACCOUNT, accountProvider: 'provider', accountId: 'other' },
        { type: GlyphWorkbenchCommandType.REQUEST_SNAPSHOT, afterSequence: 0 },
      ]);
      expect(service.state).toMatchObject({
        catalogPending: false,
        selectedAccount: { provider: 'provider', id: 'other' },
        selectedModel: 'fast',
        models: [{ slug: 'fast', name: 'Fast' }],
      });
    });

    it('reports accounts without models', async () => {
      const { service } = await workbench({ saved: { 'glyph.selectedChat': '' }, extra: { catalog: { other: [] } } });

      await service.selectAccount('provider', 'other');

      expect(service.state.navigationError).toBe('No models are available for this account.');
      expect(service.state.selectedModel).toBeUndefined();
    });

    it('reports catalog failures', async () => {
      for (const failure of [new Error('Signed out.'), 'Signed out.']) {
        const { service } = await workbench({
          saved: { 'glyph.selectedChat': '' },
          handler: command => {
            if (command.type === GlyphWorkbenchCommandType.SELECT_ACCOUNT) throw failure;
          },
        });

        await service.selectAccount('provider', 'other');

        expect(service.state).toMatchObject({ navigationError: 'Signed out.', catalogPending: false });
      }
    });

    it.each([GlyphWorkbenchCommandType.SELECT_ACCOUNT, GlyphWorkbenchCommandType.REQUEST_SNAPSHOT])(
      'ignores an earlier account whose %s finishes late',
      async held => {
        const late = gate();
        let hold = true;
        const { service } = await workbench({
          saved: { 'glyph.selectedChat': '' },
          extra: {
            catalog: {
              first: [{ slug: 'first-model', name: 'First' }],
              second: [{ slug: 'second-model', name: 'Second' }],
            },
          },
          handler: async (command, host) => {
            host.respond(command);
            if (hold && command.type === held) {
              hold = false;
              await late.hold();
            }
          },
        });

        const first = service.selectAccount('provider', 'first');
        await late.entered;
        await service.selectAccount('provider', 'second');
        late.release();
        await first;

        expect(service.state).toMatchObject({
          selectedAccount: { provider: 'provider', id: 'second' },
          selectedModel: 'second-model',
          catalogPending: false,
        });
      },
    );

    it('ignores failures of an earlier account', async () => {
      const late = gate();
      let hold = true;
      const { service } = await workbench({
        saved: { 'glyph.selectedChat': '' },
        handler: async (command, host) => {
          if (hold && command.type === GlyphWorkbenchCommandType.SELECT_ACCOUNT) {
            hold = false;
            await late.hold();
            throw new Error('Signed out.');
          }
          host.respond(command);
        },
      });

      const first = service.selectAccount('provider', 'first');
      await late.entered;
      await service.selectAccount('provider', 'second');
      late.release();
      await first;

      expect(service.state.navigationError).toBeUndefined();
      expect(service.state.selectedModel).toBe('model');
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.selectModel, () => {
    async function draft(handler?: Handler) {
      const test = await workbench({
        saved: { 'glyph.selectedChat': '' },
        accounts: [account],
        extra: {
          catalog: {
            account: [
              { slug: 'model', name: 'Model' },
              { slug: 'deep', name: 'Deep' },
              { slug: 'fast', name: 'Fast' },
            ],
          },
        },
        ...(handler ? { handler } : {}),
      });
      await vi.waitFor(() => {
        expect(test.service.state.selectedModel).toBe('model');
      });
      test.host.request.mockClear();
      return test;
    }

    it('selects a model of the new chat account', async () => {
      const { service, commands } = await draft();

      const selecting = service.selectModel('deep');
      expect(service.state.catalogPending).toBe(true);
      await selecting;

      expect(commands()).toEqual([{ type: GlyphWorkbenchCommandType.SELECT_MODEL, model: 'deep' }]);
      expect(service.state).toMatchObject({ selectedModel: 'deep', catalogPending: false });
    });

    it('restores the account catalog on a replacement host first', async () => {
      const { service, host, types } = await draft();
      host.state = { ...host.state, selectedAccount: { provider: 'provider', id: 'elsewhere' } };
      emit(host, { type: GlyphHostEventType.INITIAL_STATE, state: host.snapshot() });

      await service.selectModel('deep');

      expect(types()).toEqual([
        GlyphWorkbenchCommandType.SELECT_ACCOUNT,
        GlyphWorkbenchCommandType.REQUEST_SNAPSHOT,
        GlyphWorkbenchCommandType.SELECT_MODEL,
      ]);
    });

    it.each([
      GlyphWorkbenchCommandType.SELECT_ACCOUNT,
      GlyphWorkbenchCommandType.REQUEST_SNAPSHOT,
      GlyphWorkbenchCommandType.SELECT_MODEL,
    ])('keeps the latest model when an earlier %s finishes late', async held => {
      const late = gate();
      let hold = false;
      const test = await draft(async (command, host) => {
        if (hold && command.type === held) {
          hold = false;
          await late.hold();
        }
        host.respond(command);
      });
      const restoreAccount = () => {
        test.host.state = { ...test.host.state, selectedAccount: undefined };
        emit(test.host, { type: GlyphHostEventType.INITIAL_STATE, state: test.host.snapshot() });
      };
      restoreAccount();
      hold = true;

      const first = test.service.selectModel('deep');
      await late.entered;
      restoreAccount();
      await test.service.selectModel('fast');
      late.release();
      await first;

      expect(test.service.state).toMatchObject({ selectedModel: 'fast', catalogPending: false });
      expect(test.commands().filter(command => command.type === GlyphWorkbenchCommandType.SELECT_MODEL)).toEqual(
        held === GlyphWorkbenchCommandType.SELECT_MODEL
          ? [
              { type: GlyphWorkbenchCommandType.SELECT_MODEL, model: 'deep' },
              { type: GlyphWorkbenchCommandType.SELECT_MODEL, model: 'fast' },
            ]
          : [{ type: GlyphWorkbenchCommandType.SELECT_MODEL, model: 'fast' }],
      );
    });

    it('keeps the latest model when selections overlap', async () => {
      const { service, commands } = await draft();

      const first = service.selectModel('deep');
      const second = service.selectModel('fast');
      await Promise.all([first, second]);

      expect(service.state).toMatchObject({ selectedModel: 'fast', catalogPending: false });
      expect(commands()).toEqual([{ type: GlyphWorkbenchCommandType.SELECT_MODEL, model: 'fast' }]);
    });

    it('reports models the host refuses', async () => {
      for (const failure of [new Error('Unknown model.'), 'Unknown model.']) {
        const { service } = await draft((command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SELECT_MODEL) throw failure;
          host.respond(command);
        });

        await expect(service.selectModel('deep')).rejects.toBe(failure);

        expect(service.state).toMatchObject({ navigationError: 'Unknown model.', catalogPending: false });
        expect(service.state.selectedModel).toBeUndefined();
      }
    });

    it('ignores the refusal of an earlier model', async () => {
      const late = gate();
      let hold = true;
      const { service } = await draft(async (command, host) => {
        if (hold && command.type === GlyphWorkbenchCommandType.SELECT_MODEL) {
          hold = false;
          await late.hold();
          throw new Error('Unknown model.');
        }
        host.respond(command);
      });

      const first = service.selectModel('deep');
      await late.entered;
      await service.selectModel('fast');
      late.release();

      await expect(first).rejects.toThrow('Unknown model.');
      expect(service.state.selectedModel).toBe('fast');
      expect(service.state.navigationError).toBeUndefined();
    });

    it('drops the model when the session is retired while selecting it', async () => {
      const test = await draft((command, host) => {
        if (command.type === GlyphWorkbenchCommandType.SELECT_MODEL) test.changeProfile('other');
        host.respond(command);
      });

      await expect(test.service.selectModel('deep')).rejects.toThrow(
        'Profile changed. Reload the window to reconnect Glyph.',
      );
      expect(test.service.state.selectedModel).toBeUndefined();
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.moveQueuedToNewChat, () => {
    async function queued() {
      const test = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });
      const source = test.service.composer;
      source.setDraft('Later');
      source.enqueueDraft();
      return { ...test, source, id: source.snapshot.queued[0].id };
    }

    it('moves a queued message into a new chat draft', async () => {
      const { service, source, id } = await queued();

      await service.moveQueuedToNewChat(id);

      expect(service.state.selectedChatId).toBeUndefined();
      expect(service.composer.snapshot.draft).toBe('Later');
      expect(service.composer.snapshot.focus).toBe(1);
      expect(source.snapshot.queued).toEqual([]);
    });

    it('ignores unknown messages and messages being edited', async () => {
      const { service, source, id } = await queued();

      await service.moveQueuedToNewChat('unknown');
      source.editQueued(id);
      await service.moveQueuedToNewChat(id);

      expect(service.state.selectedChatId).toBe('alpha');
      expect(source.snapshot.queued).toHaveLength(1);
    });

    it('waits for a chat transition to finish', async () => {
      const opening = gate();
      const { service } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.OPEN_CHAT && command.chatId === 'beta') await opening.hold();
          host.respond(command);
        },
      });
      const pending = service.openChat('beta');
      await opening.entered;

      await expect(service.moveQueuedToNewChat('queued-1')).rejects.toThrow('Wait for the current chat transition.');
      opening.release();
      await pending;
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.newChat, () => {
    it('selects an empty new chat draft', async () => {
      const { service, storage } = await workbench();

      service.newChat();

      expect(service.state.selectedChatId).toBeUndefined();
      expect(service.state.openChatIds).toEqual(['alpha', '']);
      expect(storage.get('glyph.selectedChat')).toBe('');
    });

    it('reports a failure to connect the new chat', async () => {
      const { service, host } = await workbench();
      host.connectHandler = () => {
        throw new Error('Host unavailable.');
      };

      service.newChat();

      await vi.waitFor(() => {
        expect(service.state.transcript.at(-1)?.text).toBe('Host unavailable.');
      });
    });

    it('stays on the chat while a message is being sent', async () => {
      const sending = gate();
      const { service } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SEND) await sending.hold();
          host.respond(command);
        },
      });
      const send = service.send('Hello');
      await sending.entered;

      service.newChat();

      expect(service.state.selectedChatId).toBe('alpha');
      sending.release();
      await send;
    });

    it('stays on the chat while the workspace is updating or retired', async () => {
      const updating = await workbench();
      const retired = await workbench();
      updating.changeFolders([], false);
      retired.changeProfile('other');

      updating.service.newChat();
      retired.service.newChat();

      expect(updating.service.state.selectedChatId).toBe('alpha');
      expect(retired.service.state.selectedChatId).toBe('alpha');
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.setChatArchived, () => {
    it('archives a chat and closes its tab', async () => {
      const { service, storage } = await workbench({ saved: { 'glyph.openChatTabs': ['alpha', 'beta'] } });

      await service.setChatArchived('beta', true);

      expect(service.state.archivedChatIds).toEqual(['beta']);
      expect(service.state.openChatIds).toEqual(['alpha']);
      expect(storage.get('glyph.archivedChatIds')).toEqual(['beta']);
    });

    it('restores an archived chat', async () => {
      const { service } = await workbench({ saved: { 'glyph.archivedChatIds': ['beta', 'gamma'] } });

      await service.setChatArchived('beta', false);

      expect(service.state.archivedChatIds).toEqual(['gamma']);
    });

    it('does not archive from a read-only window', async () => {
      const { service } = await workbench({ readOnly: true });

      await service.setChatArchived('beta', true);

      expect(service.state.archivedChatIds).toEqual([]);
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.setChatPinned, () => {
    it('pins and unpins chats', async () => {
      const { service, storage } = await workbench();

      service.setChatPinned('alpha', true);
      service.setChatPinned('beta', true);
      service.setChatPinned('alpha', false);

      expect(service.state.pinnedChatIds).toEqual(['beta']);
      expect(storage.get('glyph.pinnedChatIds')).toEqual(['beta']);
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.closeChat, () => {
    it('closes a background tab', async () => {
      const { service, storage } = await workbench({ saved: { 'glyph.openChatTabs': ['alpha', 'beta'] } });

      await service.closeChat('beta');

      expect(service.state.openChatIds).toEqual(['alpha']);
      expect(storage.get('glyph.openChatTabs')).toEqual(['alpha']);
    });

    it('opens the neighboring tab when closing the selected one', async () => {
      const { service } = await workbench({ saved: { 'glyph.openChatTabs': ['alpha', 'beta'] } });

      await service.closeChat('alpha');

      expect(service.state.selectedChatId).toBe('beta');
      expect(service.state.openChatIds).toEqual(['beta']);
    });

    it('opens a new chat draft when closing the last tab', async () => {
      const { service } = await workbench({ saved: { 'glyph.openChatTabs': ['alpha'] } });

      await service.closeChat('alpha');

      expect(service.state.selectedChatId).toBeUndefined();
      expect(service.state.openChatIds).toEqual(['']);
    });

    it('closes the new chat draft tab', async () => {
      const { service } = await workbench({
        saved: { 'glyph.selectedChat': '', 'glyph.openChatTabs': ['', 'alpha'] },
      });

      await service.closeChat('');

      expect(service.state.selectedChatId).toBe('alpha');
      expect(service.state.openChatIds).toEqual(['alpha']);
    });

    it('keeps the tab when its neighbor cannot be opened', async () => {
      const { service } = await workbench({
        saved: { 'glyph.openChatTabs': ['alpha', 'beta'] },
        handler: (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.OPEN_CHAT && command.chatId === 'beta')
            throw new Error('Unavailable.');
          host.respond(command);
        },
      });

      await service.closeChat('alpha');

      expect(service.state.selectedChatId).toBe('alpha');
      expect(service.state.openChatIds).toEqual(['alpha', 'beta']);
    });

    it('ignores tabs that are not open and read-only windows', async () => {
      const unknown = await workbench({ saved: { 'glyph.openChatTabs': ['alpha'] } });
      const readOnly = await workbench({ readOnly: true, saved: { 'glyph.openChatTabs': ['alpha', 'beta'] } });

      await unknown.service.closeChat('beta');
      await readOnly.service.closeChat('beta');

      expect(unknown.service.state.openChatIds).toEqual(['alpha']);
      expect(readOnly.service.state.openChatIds).toEqual(['alpha', 'beta']);
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.createChat, () => {
    it('opens the created chat with an empty draft and keeps the previous draft', async () => {
      const { service, commands } = await workbench();
      const previous = service.composer;
      previous.setDraft('Alpha draft');

      await service.createChat('provider', 'account', 'deep');

      expect(commands().at(-1)).toEqual({
        type: GlyphWorkbenchCommandType.CREATE_CHAT,
        creationId: expect.any(String),
        accountProvider: 'provider',
        accountId: 'account',
        model: 'deep',
      });
      expect(service.state.selectedChatId).toBe('created-1');
      expect(service.composer).not.toBe(previous);
      expect(previous.snapshot.draft).toBe('Alpha draft');
    });

    it('refuses to create chats concurrently', async () => {
      const creating = gate();
      const { service } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.CREATE_CHAT) await creating.hold();
          host.respond(command);
        },
      });
      const first = service.createChat('provider', 'account', 'model');
      await creating.entered;

      await expect(service.createChat('provider', 'account', 'model')).rejects.toThrow(
        'Another chat is being created. Try again when it finishes.',
      );
      creating.release();
      await first;
    });

    it('requires the host to acknowledge the new chat', async () => {
      const { service } = await workbench({ handler: () => {} });

      await expect(service.createChat('provider', 'account', 'model')).rejects.toThrow(
        'The new chat was not acknowledged. Try again.',
      );
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.branchChat, () => {
    it('opens the branched chat', async () => {
      const { service, host, commands } = await workbench({
        handler: (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.BRANCH_CHAT)
            host.emit({ type: GlyphHostEventType.CHAT_UPDATED, chat: chat('branch'), creationId: command.creationId });
          host.respond(command);
        },
      });

      await service.branchChat('alpha', 'turn');

      expect(commands().at(-1)).toEqual({
        type: GlyphWorkbenchCommandType.BRANCH_CHAT,
        chatId: 'alpha',
        turnId: 'turn',
        creationId: expect.any(String),
      });
      expect(service.state.selectedChatId).toBe('branch');
      emit(host, { type: GlyphHostEventType.CHAT_UPDATED, chat: chat('later'), creationId: 'other' });
      expect(service.state.selectedChatId).toBe('branch');
    });

    it('ignores branches while another chat is being created', async () => {
      const creating = gate();
      const { service, types } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.CREATE_CHAT) await creating.hold();
          host.respond(command);
        },
      });
      const creation = service.createChat('provider', 'account', 'model');
      await creating.entered;

      await service.branchChat('alpha', 'turn');

      expect(types()).not.toContain(GlyphWorkbenchCommandType.BRANCH_CHAT);
      creating.release();
      await creation;
    });
  });

  describe(NativeGlyphWorkbenchService.prototype.openChat, () => {
    it('opens and remembers the chat', async () => {
      const { service, storage } = await workbench();

      const opening = service.openChat('beta');
      expect(service.state.navigationPending).toBe(true);
      await opening;

      expect(service.state).toMatchObject({ selectedChatId: 'beta', navigationPending: false });
      expect(storage.get('glyph.selectedChat')).toBe('beta');
      expect(storage.get('glyph.openChatTabs')).toEqual(['alpha', 'beta']);
    });

    it('reports chats that cannot be opened', async () => {
      for (const failure of [new Error('Unavailable.'), 'Unavailable.']) {
        const { service } = await workbench({
          handler: (command, host) => {
            if (command.type === GlyphWorkbenchCommandType.OPEN_CHAT && command.chatId === 'beta') throw failure;
            host.respond(command);
          },
        });

        await service.openChat('beta');

        expect(service.state).toMatchObject({
          selectedChatId: 'alpha',
          navigationPending: false,
          navigationError: 'Unavailable.',
        });
      }
    });

    it('ignores an earlier navigation that finishes late', async () => {
      for (const fails of [false, true]) {
        const opening = gate();
        const { service } = await workbench({
          handler: async (command, host) => {
            if (command.type === GlyphWorkbenchCommandType.OPEN_CHAT && command.chatId === 'beta') {
              await opening.hold();
              if (fails) throw new Error('Unavailable.');
            }
            host.respond(command);
          },
        });

        const late = service.openChat('beta');
        await opening.entered;
        await service.openChat('alpha');
        opening.release();
        await late;

        expect(service.state.selectedChatId).toBe('alpha');
        expect(service.state.navigationError).toBeUndefined();
      }
    });

    it('stays on the chat while a message is being sent', async () => {
      const sending = gate();
      const { service, commands } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.SEND) await sending.hold();
          host.respond(command);
        },
      });
      const send = service.send('Hello');
      await sending.entered;

      await service.openChat('beta');

      expect(service.state.selectedChatId).toBe('alpha');
      expect(commands()).not.toContainEqual({ type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId: 'beta' });
      sending.release();
      await send;
    });
  });

  describe('background terminals', () => {
    const shell = {
      id: 'shell',
      chatId: 'alpha',
      command: 'npm test',
      workingDirectory: '/project',
      output: '',
      running: true,
    };

    it('opens a background terminal of a chat', async () => {
      const { service, shells } = await workbench({ extra: { shells: [shell] } });

      await service.openShell('alpha', 'shell');

      expect(shells.open).toHaveBeenCalledWith(shell);
    });

    it('refuses terminals that are no longer available', async () => {
      const { service } = await workbench({ extra: { shells: [shell] } });
      const withoutShells = await workbench();

      await expect(service.openShell('beta', 'shell')).rejects.toThrow(
        'This background terminal is no longer available.',
      );
      await expect(withoutShells.service.openShell('alpha', 'shell')).rejects.toThrow(
        'This background terminal is no longer available.',
      );
    });

    it('stops a running terminal when its viewer closes', async () => {
      const { shells, commands } = await workbench({ extra: { shells: [shell] } });

      shells.close(shell);

      await vi.waitFor(() => {
        expect(commands().at(-1)).toEqual({
          type: GlyphWorkbenchCommandType.STOP_SHELL_SESSION,
          chatId: 'alpha',
          sessionId: 'shell',
        });
      });
    });

    it('reports terminals that cannot be stopped', async () => {
      const { service, shells } = await workbench({
        extra: { shells: [shell] },
        handler: (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.STOP_SHELL_SESSION) throw 'Already exited.';
          host.respond(command);
        },
      });

      shells.close(shell);

      await vi.waitFor(() => {
        expect(service.state.transcript.at(-1)?.text).toBe('Already exited.');
      });
    });

    it('leaves finished terminals and terminals of read-only windows alone', async () => {
      const finished = await workbench({ extra: { shells: [{ ...shell, running: false }] } });
      const readOnly = await workbench({ readOnly: true, extra: { shells: [shell] } });
      const untracked = await workbench();

      finished.shells.close(shell);
      readOnly.shells.close(shell);
      untracked.shells.close(shell);
      await flush();

      for (const test of [finished, readOnly, untracked])
        expect(test.types()).not.toContain(GlyphWorkbenchCommandType.STOP_SHELL_SESSION);
    });
  });

  describe('proposal review', () => {
    it('forwards review commands and opens proposal files', async () => {
      const { service, proposals } = await workbench();

      service.executeReviewCommand(GlyphReviewCommand.KEEP);
      await service.reviewProposalFile('alpha', 'proposal', 'file');

      expect(proposals.executeCommand).toHaveBeenCalledWith(GlyphReviewCommand.KEEP);
      expect(proposals.open).toHaveBeenCalledWith('alpha', 'proposal', 'file');
    });

    it('accepts items in order and rejects them in reverse order', async () => {
      const { service, proposals, commands } = await workbench();
      const items = [
        { proposalId: 'proposal', itemId: 'one' },
        { proposalId: 'proposal', itemId: 'two' },
      ];

      await service.decideProposalItems('alpha', items, true);
      await service.decideProposalItems('alpha', items, false, 'Not this.');

      expect(commands().slice(-4)).toEqual([
        {
          type: GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM,
          chatId: 'alpha',
          proposalId: 'proposal',
          itemId: 'one',
        },
        {
          type: GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM,
          chatId: 'alpha',
          proposalId: 'proposal',
          itemId: 'two',
        },
        {
          type: GlyphWorkbenchCommandType.REJECT_PROPOSAL_ITEM,
          chatId: 'alpha',
          proposalId: 'proposal',
          itemId: 'two',
          comment: 'Not this.',
        },
        {
          type: GlyphWorkbenchCommandType.REJECT_PROPOSAL_ITEM,
          chatId: 'alpha',
          proposalId: 'proposal',
          itemId: 'one',
          comment: 'Not this.',
        },
      ]);
      expect(proposals.refresh).toHaveBeenCalledTimes(2);
    });

    it('refuses overlapping decisions', async () => {
      const deciding = gate();
      const { service, proposals } = await workbench({
        handler: async (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM) await deciding.hold();
          host.respond(command);
        },
      });
      const items = [{ proposalId: 'proposal', itemId: 'one' }];
      const first = service.decideProposalItems('alpha', items, true);
      await deciding.entered;

      await expect(proposals.host.decide('alpha' as never, items as never, true as never)).rejects.toEqual(
        new GlyphProposalReviewError(GlyphDesktopErrorCode.CHAT_BUSY, 'Another review decision is still being saved.'),
      );
      deciding.release();
      await first;
    });

    it('allows a new decision after a failed one', async () => {
      const { service, proposals } = await workbench({
        handler: (command, host) => {
          if (command.type === GlyphWorkbenchCommandType.ACCEPT_PROPOSAL_ITEM) throw new Error('Stale.');
          host.respond(command);
        },
      });
      const items = [{ proposalId: 'proposal', itemId: 'one' }];

      await expect(service.decideProposalItems('alpha', items, true)).rejects.toThrow('Stale.');
      await service.decideProposalItems('alpha', items, false);

      expect(proposals.refresh).toHaveBeenCalledTimes(1);
    });

    it('gives the review editor the window state, draft and diagnostics', async () => {
      const { service, proposals } = await workbench();

      proposals.host.report(new Error('Review failed.') as never);

      expect(proposals.host.state()).toEqual(service.state);
      expect(proposals.host.composer()).toBe(service.composer);
      expect(service.state.transcript.at(-1)?.text).toBe('Review failed.');
    });

    it('lets the review editor read proposal files', async () => {
      const { proposals, commands } = await workbench();

      await proposals.host.read('alpha' as never, 'proposal' as never, 'file' as never);

      expect(commands().at(-1)).toEqual({
        type: GlyphWorkbenchCommandType.READ_PROPOSAL_FILE,
        chatId: 'alpha',
        proposalId: 'proposal',
        fileId: 'file',
      });
    });

    it('saves commented annotations in the draft of their chat', async () => {
      const { service, proposals } = await workbench({ saved: { 'glyph.selectedChat': 'beta' } });
      const annotation = {
        id: 'annotation',
        order: 0,
        kind: 'proposal',
        sourceId: 'proposal',
        revision: '1',
        label: 'a.ts',
        quote: 'code',
        from: 0,
        to: 4,
        comment: 'Rename this.',
      } as GlyphAnnotation;

      await proposals.host.annotate('alpha' as never, annotation as never);

      expect(service.state.selectedChatId).toBe('alpha');
      expect(service.composer.snapshot.document.options?.annotations).toEqual([{ ...annotation, order: 1 }]);
      await service.composer.revealAnnotation(annotation);
      expect(proposals.revealAnnotation).toHaveBeenCalledWith(annotation);
    });

    it('asks for a comment on uncommented annotations after the existing ones', async () => {
      const { service, proposals } = await workbench();
      const annotation = {
        id: 'annotation',
        order: 0,
        kind: 'proposal',
        sourceId: 'proposal',
        revision: '1',
        label: 'a.ts',
        quote: 'code',
        from: 0,
        to: 4,
        comment: '',
      } as GlyphAnnotation;

      await proposals.host.annotate('alpha' as never, annotation as never);
      expect(service.composer.snapshot.annotationDraft).toEqual({ ...annotation, order: 1 });
      service.composer.saveAnnotation({ ...annotation, id: 'first', comment: 'First.' });
      service.composer.saveAnnotation({ ...annotation, id: 'second', comment: 'Second.' });
      await proposals.host.annotate('alpha' as never, { ...annotation, id: 'third' } as never);

      expect(service.composer.snapshot.annotationDraft).toEqual({ ...annotation, id: 'third', order: 3 });
    });
  });

  describe('queued messages', () => {
    it('sends a queued message once its chat is idle', async () => {
      const { service, host, commands } = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });
      service.composer.setDraft('Next');
      service.composer.enqueueDraft();
      await flush();
      expect(commands().some(command => command.type === GlyphWorkbenchCommandType.SEND)).toBe(false);

      emit(host, { type: GlyphHostEventType.RUN_STATE, run: run('alpha', 'live', GlyphRunStatus.COMPLETED) });

      await vi.waitFor(() => {
        expect(commands().at(-1)).toMatchObject({
          type: GlyphWorkbenchCommandType.SEND,
          chatId: 'alpha',
          text: 'Next',
        });
      });
    });

    it('sends queued messages of background chats', async () => {
      const { service, host, commands } = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });
      service.composer.setDraft('Next');
      service.composer.enqueueDraft();
      await service.openChat('beta');

      emit(host, { type: GlyphHostEventType.RUN_STATE, run: run('alpha', 'live', GlyphRunStatus.COMPLETED) });

      await vi.waitFor(() => {
        expect(commands().at(-1)).toMatchObject({ type: GlyphWorkbenchCommandType.SEND, chatId: 'alpha' });
      });
      expect(service.state.status).toBe(GlyphWorkbenchStatus.READY);
    });

    it('keeps paused queues, new chat queues and queues of read-only windows', async () => {
      const paused = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });
      paused.service.composer.setDraft('Paused');
      paused.service.composer.enqueueDraft();
      paused.service.composer.pauseQueue();
      emit(paused.host, { type: GlyphHostEventType.RUN_STATE, run: run('alpha', 'live', GlyphRunStatus.COMPLETED) });
      const draft = await workbench({ saved: { 'glyph.selectedChat': '' } });
      draft.service.composer.setDraft('Draft');
      draft.service.composer.enqueueDraft();
      const readOnly = await workbench({ readOnly: true });
      readOnly.service.composer.setDraft('Read-only');
      readOnly.service.composer.enqueueDraft();

      await flush();

      for (const test of [paused, draft, readOnly]) expect(test.types()).not.toContain(GlyphWorkbenchCommandType.SEND);
    });

    it('keeps a queued message for after a turn the host starts first', async () => {
      let hostTurnFirst = true;
      const { service, host, types } = await workbench({
        runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)],
        handler: (command, client) => {
          if (command.type !== GlyphWorkbenchCommandType.SEND || !hostTurnFirst) return;
          hostTurnFirst = false;
          client.emit({
            type: GlyphHostEventType.RUN_STATE,
            run: run('alpha', 'shell-event:wake', GlyphRunStatus.STREAMING),
          });
          throw new Error('INVALID_REQUEST: This chat already has an active run or history change.');
        },
      });
      service.composer.setDraft('A queued follow-up.');
      service.composer.enqueueDraft();

      emit(host, { type: GlyphHostEventType.RUN_STATE, run: run('alpha', 'live', GlyphRunStatus.COMPLETED) });

      await vi.waitFor(() => {
        expect(hostTurnFirst).toBe(false);
      });
      await vi.waitFor(() => {
        expect(service.composer.snapshot.queueSubmitting).toBeUndefined();
      });
      expect(service.composer.snapshot).toMatchObject({ queuePaused: false, queueError: undefined });
      expect(service.composer.snapshot.queued).toHaveLength(1);
      expect(service.state.transcript.filter(entry => entry.role === GlyphTranscriptRole.DIAGNOSTIC)).toEqual([]);

      emit(host, {
        type: GlyphHostEventType.RUN_STATE,
        run: run('alpha', 'shell-event:wake', GlyphRunStatus.COMPLETED),
      });

      await vi.waitFor(() => {
        expect(service.composer.snapshot.queued).toEqual([]);
      });
      expect(types().filter(type => type === GlyphWorkbenchCommandType.SEND)).toHaveLength(2);
    });

    it('pauses and reports a queued message that fails while its chat is idle', async () => {
      const { service } = await workbench({
        handler: command => {
          if (command.type === GlyphWorkbenchCommandType.SEND) throw new Error('The provider rejected the message.');
        },
      });
      service.composer.setDraft('A queued follow-up.');

      service.composer.enqueueDraft();

      await vi.waitFor(() => {
        expect(service.composer.snapshot).toMatchObject({
          queuePaused: true,
          queueError: 'The provider rejected the message.',
          queueSubmitting: undefined,
        });
      });
      expect(service.composer.snapshot.queued).toHaveLength(1);
      expect(service.state.transcript.filter(entry => entry.role === GlyphTranscriptRole.DIAGNOSTIC)).toEqual([
        expect.objectContaining({ text: 'The provider rejected the message.' }),
      ]);
    });
  });

  describe('workspace changes', () => {
    it('rebinds the conversation to the changed workspace folders', async () => {
      const test = await workbench({ runs: [run('alpha', 'live', GlyphRunStatus.STREAMING)] });
      test.service.composer.insertAttachments([attachment()]);
      test.service.composer.setDraft('Queued');
      test.service.composer.enqueueDraft();
      test.host.request.mockClear();

      test.changeFolders([folder('project'), folder('docs')]);

      expect(test.service.state).toMatchObject({
        readOnly: true,
        navigationPending: true,
        workspaceRetryable: false,
        workspaceMessage: 'Updating workspace folders…',
        status: GlyphWorkbenchStatus.DISCONNECTED,
      });
      expect(test.service.composer.snapshot.queuePaused).toBe(true);
      expect(test.editor.invalidate).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toBe('Workspace updated: project, docs. Continue when ready.');
      });
      expect(test.host.detachWorkspace).toHaveBeenCalled();
      expect(test.editor.rebindWorkspace).toHaveBeenCalled();
      expect(test.host.connect).toHaveBeenLastCalledWith(
        [
          { name: 'project', uri: 'file:///project', canonicalPath: URI.file('/project').fsPath },
          { name: 'docs', uri: 'file:///docs', canonicalPath: URI.file('/docs').fsPath },
        ],
        true,
      );
      expect(test.commands()).toEqual([{ type: GlyphWorkbenchCommandType.OPEN_CHAT, chatId: 'alpha' }]);
      expect(test.storage.get('glyph.selectedChat')).toBe('alpha');
      expect(test.service.state.readOnly).toBe(false);
      expect(test.service.composer.snapshot.queued[0].document.parts).toEqual([{ type: 'text', text: 'Queued' }]);
    });

    it('rebinds captures in drafts to the changed workspace', async () => {
      const test = await workbench();
      test.service.composer.insertAttachments([attachment()]);

      test.changeFolders([folder('project'), folder('docs')]);
      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toMatch(/^Workspace updated/u);
      });

      expect(test.service.composer.snapshot.document.parts).toEqual([
        { type: 'attachment', attachment: { ...attachment(), sourceRevision: 'rebound' } },
      ]);
    });

    it('restores the new chat account and model after the workspace changes', async () => {
      const trusted = await workbench({ saved: { 'glyph.selectedChat': '' }, accounts: [account] });
      const untrusted = await workbench({ saved: { 'glyph.selectedChat': '' }, accounts: [account], trusted: false });
      for (const test of [trusted, untrusted]) {
        await vi.waitFor(() => {
          expect(test.service.state.selectedModel).toBe('model');
        });
        test.host.request.mockClear();

        test.changeFolders([folder('docs')]);
        await vi.waitFor(() => {
          expect(test.service.state.workspaceMessage).toMatch(/^Workspace updated/u);
        });
      }

      expect(trusted.commands()).toEqual([
        { type: GlyphWorkbenchCommandType.SELECT_ACCOUNT, accountProvider: 'provider', accountId: 'account' },
        { type: GlyphWorkbenchCommandType.SELECT_MODEL, model: 'model' },
      ]);
      expect(untrusted.commands()).toEqual([]);
      expect(trusted.storage.get('glyph.selectedChat')).toBe('');
    });

    it('rebinds when the workspace identity changes', async () => {
      const renamed = await workbench();
      const unchanged = await workbench();

      renamed.workspace.configuration = URI.file('/project.code-workspace');
      renamed.renameWorkspace();
      unchanged.changeWorkbenchState();

      await vi.waitFor(() => {
        expect(renamed.service.state.workspaceMessage).toMatch(/^Workspace updated/u);
      });
      expect(unchanged.service.state.workspaceMessage).toBeUndefined();
      expect(unchanged.host.detachWorkspace).not.toHaveBeenCalled();
    });

    it('asks for a local folder when none remain and continues once one is added', async () => {
      const test = await workbench();

      test.changeFolders([]);
      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toBe(
          'Add a local workspace folder to continue. Your conversation and draft are preserved.',
        );
      });

      expect(test.service.state).toMatchObject({ readOnly: true, workspaceRetryable: false });
      await expect(test.service.send('Hello')).rejects.toThrow(
        'Add a local workspace folder to continue. Your conversation and draft are preserved.',
      );
      test.changeFolders([folder('docs')]);
      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toBe('Workspace updated: docs. Continue when ready.');
      });
    });

    it('lets the user retry a failed update', async () => {
      for (const failure of [new Error('Host unavailable.'), 'Host unavailable.']) {
        const test = await workbench();
        test.host.connectHandler = () => {
          throw failure;
        };

        test.changeFolders([folder('docs')]);
        await vi.waitFor(() => {
          expect(test.service.state.workspaceMessage).toBe('Could not update workspace folders: Host unavailable.');
        });

        expect(test.service.state.workspaceRetryable).toBe(true);
        test.host.connectHandler = () => {};
        await test.service.connect();
        expect(test.service.state.workspaceMessage).toBe('Workspace updated: docs. Continue when ready.');
      }
    });

    it('rebinds again when folders change during the update', async () => {
      const connecting = gate();
      const test = await workbench();
      let first = true;
      test.host.connectHandler = async () => {
        if (!first) return;
        first = false;
        await connecting.hold();
      };

      test.changeFolders([folder('docs')]);
      await connecting.entered;
      test.changeFolders([folder('docs'), folder('notes')]);
      connecting.release();

      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toBe('Workspace updated: docs, notes. Continue when ready.');
      });
      expect(test.host.detachWorkspace).toHaveBeenCalledTimes(2);
    });

    it('rebinds again when folders change while reopening the chat', async () => {
      const test = await workbench();
      let change = true;
      test.host.handler = (command, host) => {
        if (change && command.type === GlyphWorkbenchCommandType.OPEN_CHAT) {
          change = false;
          test.changeFolders([folder('docs'), folder('notes')], false);
        }
        host.respond(command);
      };

      test.changeFolders([folder('docs')]);

      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toBe('Workspace updated: docs, notes. Continue when ready.');
      });
    });

    it('rebinds again when folders change as an update fails', async () => {
      const test = await workbench();
      let fail = true;
      test.host.connectHandler = () => {
        if (!fail) return;
        fail = false;
        test.changeFolders([folder('docs'), folder('notes')], false);
        throw new Error('Superseded.');
      };

      test.changeFolders([folder('docs')]);

      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toBe('Workspace updated: docs, notes. Continue when ready.');
      });
    });

    it('rebinds again when folders change as an update finishes', async () => {
      const test = await workbench();
      let added = false;
      const poll = (): void => {
        if (test.service.state.workspaceMessage?.startsWith('Add a local') === true) {
          added = true;
          test.changeFolders([folder('docs')], false);
        } else queueMicrotask(poll);
      };

      test.changeFolders([]);
      queueMicrotask(poll);

      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toBe('Workspace updated: docs. Continue when ready.');
      });
      expect(added).toBe(true);
    });

    it('rejects actions while folders are updating', async () => {
      const test = await workbench();

      test.changeFolders([folder('docs')], false);

      await expect(test.service.send('Hello')).rejects.toThrow('Updating workspace folders…');
    });

    it('rejects actions that span an update', async () => {
      const connecting = gate();
      const test = await workbench();
      let hold = true;
      test.host.connectHandler = async () => {
        if (!hold) return;
        hold = false;
        await connecting.hold();
      };

      const pending = test.service.cancelRun('alpha', 'run');
      await connecting.entered;
      test.changeFolders([folder('docs')]);
      await vi.waitFor(() => {
        expect(test.service.state.workspaceMessage).toMatch(/^Workspace updated/u);
      });
      connecting.release();

      await expect(pending).rejects.toThrow('Workspace changed while the action was pending. Please try again.');
    });

    it('reconnects with the changed trust', async () => {
      const test = await workbench();

      test.setTrust(false);

      expect(test.editor.invalidate).toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(test.host.connect).toHaveBeenLastCalledWith(expect.any(Array), false);
      });
    });

    it('reports reconnection failures', async () => {
      const test = await workbench();
      test.host.connectHandler = () => {
        throw 'Trust denied.';
      };

      test.setTrust(false);

      await vi.waitFor(() => {
        expect(test.service.state.transcript.at(-1)?.text).toBe('Trust denied.');
      });
    });
  });

  describe('retired sessions', () => {
    it('retires the session when the profile changes', async () => {
      const test = await workbench();
      const connections = test.host.connect.mock.calls.length;

      test.changeProfile('other');
      test.changeProfile('another');
      test.setTrust(false);
      emit(test.host, { type: GlyphHostEventType.USAGE, chatId: 'alpha', usage: { inputTokens: 1 } });

      expect(test.host.dispose).toHaveBeenCalledTimes(1);
      expect(test.host.connect).toHaveBeenCalledTimes(connections);
      expect(test.service.state.status).toBe(GlyphWorkbenchStatus.DISCONNECTED);
      expect(test.service.state.usage).toEqual({});
      expect(test.service.state.transcript).toEqual([
        {
          id: expect.any(String),
          role: GlyphTranscriptRole.DIAGNOSTIC,
          text: 'Profile changed. Reload the window to reconnect Glyph.',
        },
      ]);
      await expect(test.service.send('Hello')).rejects.toThrow(
        'Profile changed. Reload the window to reconnect Glyph.',
      );
    });

    it('stops updating folders once the session is retired', async () => {
      const detaching = gate();
      const test = await workbench();
      test.host.detachHandler = () => detaching.hold();

      test.changeFolders([folder('docs')]);
      await detaching.entered;
      test.changeProfile('other');
      detaching.release();
      await flush();

      expect(test.service.state.workspaceMessage).toBe('Updating workspace folders…');
      expect(test.editor.rebindWorkspace).not.toHaveBeenCalled();
    });

    it('does not retry an update once the session is retired', async () => {
      const test = await workbench();
      test.host.connectHandler = () => {
        throw new Error('Host unavailable.');
      };
      test.changeFolders([folder('docs')]);
      await vi.waitFor(() => {
        expect(test.service.state.workspaceRetryable).toBe(true);
      });

      test.changeProfile('other');

      await expect(test.service.connect()).rejects.toThrow('Profile changed. Reload the window to reconnect Glyph.');
      expect(test.host.detachWorkspace).toHaveBeenCalledTimes(1);
    });

    it('rejects actions after it is disposed', async () => {
      const { service } = await workbench();

      service.dispose();

      expect(service.state.status).toBe(GlyphWorkbenchStatus.DISCONNECTED);
      await expect(service.send('Hello')).rejects.toThrow('Workspace changed. Reload the window to reconnect Glyph.');
    });
  });

  describe('restoring the window', () => {
    it('restores the saved chat, tabs, archived and pinned chats', async () => {
      const { service } = await workbench({
        chats: [chat('alpha'), chat('beta'), chat('gamma')],
        saved: {
          'glyph.selectedChat': 'beta',
          'glyph.openChatTabs': ['alpha', 7, 'alpha', 'beta'],
          'glyph.archivedChatIds': ['gamma', null],
          'glyph.pinnedChatIds': ['alpha', {}],
        },
      });

      expect(service.state).toMatchObject({
        selectedChatId: 'beta',
        openChatIds: ['alpha', 'beta'],
        archivedChatIds: ['gamma'],
        pinnedChatIds: ['alpha'],
      });
    });

    it('opens the first chat when no chat was saved or the saved chat is gone', async () => {
      for (const saved of [{ 'glyph.selectedChat': undefined }, { 'glyph.selectedChat': 'gone' }]) {
        const { service, storage } = await workbench({ saved, chats: [chat('alpha'), chat('beta')] });

        expect(service.state.selectedChatId).toBe('alpha');
        expect(storage.get('glyph.selectedChat')).toBe('alpha');
        expect(storage.get('glyph.openChatTabs')).toEqual(expect.arrayContaining(['alpha']));
      }
    });

    it('keeps a saved new chat draft selected', async () => {
      const { service } = await workbench({ saved: { 'glyph.selectedChat': '', 'glyph.archivedChatIds': 'x' } });

      expect(service.state.selectedChatId).toBeUndefined();
      expect(service.state.openChatIds).toEqual(['']);
      expect(service.state.archivedChatIds).toEqual([]);
    });

    it('waits for a local workspace folder before connecting', async () => {
      const { host, service } = await workbench({ folders: [folder('remote', 'vscode-remote')], connect: false });

      expect(host.connect).not.toHaveBeenCalled();
      expect(service.state.status).toBe(GlyphWorkbenchStatus.DISCONNECTED);
    });

    it('connects the local workspace folders with their trust', async () => {
      const { host } = await workbench({ folders: [folder('project'), folder('remote', 'vscode-remote')] });

      expect(host.connect).toHaveBeenCalledWith(
        [{ name: 'project', uri: 'file:///project', canonicalPath: URI.file('/project').fsPath }],
        true,
      );
    });

    it('reports a failure to restore the saved chat', async () => {
      const { service } = await workbench({
        connect: false,
        handler: () => {
          throw new Error('History unavailable.');
        },
      });

      await vi.waitFor(() => {
        expect(service.state.transcript.at(-1)?.text).toBe('History unavailable.');
      });
    });

    it('reopens the saved chat when its history is not loaded', async () => {
      const { types, commands } = await workbench();

      expect(types()).toContain(GlyphWorkbenchCommandType.OPEN_CHAT);
      expect(commands().find(command => command.type === GlyphWorkbenchCommandType.OPEN_CHAT)).toMatchObject({
        chatId: 'alpha',
      });
    });

    it('does not reopen a chat whose history is loaded', async () => {
      const { types } = await workbench({ runs: [run('alpha', 'one')] });

      expect(types()).not.toContain(GlyphWorkbenchCommandType.OPEN_CHAT);
    });

    it('selects the first account with inference access for a new chat', async () => {
      const { service, commands } = await workbench({
        saved: { 'glyph.selectedChat': '' },
        accounts: [
          { ...account, id: 'offline', connected: false },
          { ...account, id: 'limited', inferenceAccess: false },
          account,
        ],
      });

      await vi.waitFor(() => {
        expect(service.state.catalogPending).toBe(false);
      });
      expect(commands().filter(command => command.type === GlyphWorkbenchCommandType.SELECT_ACCOUNT)).toEqual([
        { type: GlyphWorkbenchCommandType.SELECT_ACCOUNT, accountProvider: 'provider', accountId: 'account' },
      ]);
      expect(service.state).toMatchObject({
        selectedAccount: { provider: 'provider', id: 'account' },
        selectedModel: 'model',
        models: [{ slug: 'model', name: 'Model' }],
      });
    });
  });
});
