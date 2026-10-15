import { describe, expect, it, vi } from 'vitest';
import { ProviderDesktopRuntime } from '#src/desktop/host/ProviderDesktopRuntime.js';
import { GlyphDesktopHost } from '#src/desktop/host/GlyphDesktopHost.js';
import { GLYPH_DESKTOP_PROTOCOL_VERSION } from '#src/desktop/protocol/GlyphDesktopProtocolVersion.js';
import { DesktopInteractionBroker } from '#src/desktop/host/DesktopInteractionBroker.js';
import { GlyphService } from '#src/application/GlyphService.js';
import { ChatSessionManager } from '#src/chat/sessions/ChatSessionManager.js';
import type { ChatSessionRecord } from '#src/chat/sessions/ChatSessionRecord.js';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import type { ChatContextEvent } from '#src/chat/ChatContextEvent.js';
import type { ChatBackend } from '#src/chat/ChatBackend.js';
import type { ChatSessionStore } from '#src/chat/sessions/ChatSessionStore.js';
import type { HttpClient } from '#src/http/HttpClient.js';
import { OpenAIModelCatalog } from '#src/providers/openai/OpenAIModelCatalog.js';
import { NullLogger } from '#src/observability/NullLogger.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { GlyphWorkbenchCommandType as Command } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import type { GlyphWorkbenchCommand } from '#src/desktop/protocol/GlyphWorkbenchCommand.js';
import { GlyphHostEventType, type GlyphHostEvent } from '#src/desktop/protocol/events/GlyphHostEvent.js';
import { GlyphRunStatus } from '#src/desktop/protocol/events/GlyphRunProjection.js';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import type { Usage } from '#src/chat/Usage.js';
import { QuestionAnswerType } from '#src/interaction/questions/QuestionAnswerType.js';
import { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import { EditProposalService } from '#src/editing/proposals/EditProposalService.js';
import { EditOperation } from '#src/editing/proposals/EditOperation.js';
import { JsDiffTextDiffer } from '#src/editing/documents/JsDiffTextDiffer.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';

const usage = { inputTokens: 2, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 1, totalTokens: 5 };
type SendOptions = Parameters<ChatProvider['send']>[1];

async function fixture(
  send: (options: SendOptions, interactions: DesktopInteractionBroker) => Promise<void | Usage | null>,
  ownerWindowId = 'owner',
  reviews?: ProposalReviewManager,
) {
  const events: GlyphHostEvent[] = [];
  const saved = new Map<string, ChatSessionRecord>();
  const recorded: ChatContextEvent[][] = [];
  let runtime: ProviderDesktopRuntime;
  const interactions = new DesktopInteractionBroker(event => runtime.publish(event));
  const account = {
    provider: 'fixture',
    id: 'account',
    label: 'Fixture account',
    detail: 'Fixture',
    connected: true,
    inferenceAccess: true,
  };
  const backend: ChatBackend = {
    presentation: {
      name: 'Fixture',
      welcome: '',
      usageDescription: '',
      accountsHeading: '',
      addAccountLabel: '',
      activeAccessLabel: '',
    },
    accounts: [account],
    initialize: async () => {},
    dispose: async () => {},
    signIn: async () => account,
    acknowledgeNotice: async () => {},
    logout: async () => true,
    redact: text => text.replaceAll('secret', '[REDACTED]'),
    listModels: async () => [{ slug: 'model', name: 'Model' }],
    createProvider: () => {
      const context: ChatContextEvent[] = [];
      const states = new Map<string, ChatContextEvent[]>();
      recorded.push(context);
      return {
        model: 'model',
        recordContext: events => {
          for (const event of events) if (!context.some(previous => previous.id === event.id)) context.push(event);
        },
        exportState: () => {
          const data = structuredClone(context);
          states.set(JSON.stringify(data), data);
          return { provider: 'fixture', version: 1, data };
        },
        restoreState: state => {
          context.splice(0, context.length, ...(states.get(JSON.stringify(state.data)) ?? []));
        },
        reset: () => {},
        send: async (_request, options) => {
          const reported = await send(options, interactions);
          return { usage: reported === undefined ? usage : reported, responseId: 'response' };
        },
      };
    },
  };
  const store: ChatSessionStore = {
    initialize: async () => {},
    load: async () => [...saved.values()],
    save: async record => {
      saved.set(record.id, structuredClone(record));
    },
    dispose: async () => {},
  };
  const sessions = new ChatSessionManager(store, {
    id: 'project',
    mutationIdentity: 'project',
    kind: ProjectContextKind.FOLDER,
    name: 'project',
    authority: 'file',
    roots: [{ name: 'project', path: '/project' }],
  });
  const glyph = new GlyphService(
    backend,
    new NullLogger(),
    { traceEnabled: false },
    reviews,
    undefined,
    undefined,
    sessions,
  );
  await glyph.initialize();
  const shells = { close: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  runtime = new ProviderDesktopRuntime({
    glyph,
    interactions,
    shellSessions: shells,
    emit: event => events.push(event),
    ownerWindowId,
  });
  await runtime.handle({ type: Command.CREATE_CHAT, accountProvider: 'fixture', accountId: 'account', model: 'model' });
  const chatId = (await runtime.snapshot()).chats[0]!.id;
  return { runtime, chatId, saved, events, glyph, shells, backend, store, recorded };
}

function reviewFixture() {
  const unexpectedMutation = async (): Promise<never> => {
    throw new Error('No file mutation is expected.');
  };
  const workspace: WorkspaceTextStore = {
    root: '/project',
    caseSensitive: true,
    mutationConsistency: WorkspaceMutationConsistency.ATOMIC_VERSIONED,
    normalizePath: path => path,
    canonicalPath: async path => `/project/${path}`,
    exists: async () => false,
    list: async () => ({ files: [], truncated: false }),
    read: unexpectedMutation,
    readOptional: async () => undefined,
    replace: unexpectedMutation,
    create: unexpectedMutation,
    rename: unexpectedMutation,
    delete: unexpectedMutation,
  };
  const store = { load: async () => [], save: vi.fn(async () => {}), clear: async () => {} };
  const reviews = new ProposalReviewManager(workspace, store);
  const compiler = new EditProposalService(workspace, new JsDiffTextDiffer(), {
    maxRawProposalBytes: 1048576,
    maxChangedBytes: 1048576,
    maxResultingBytesPerFile: 1048576,
    maxFiles: 64,
    maxTotalHunks: 256,
    maxHunksPerFile: 64,
    diffBudgetMs: 1000,
    maxActiveReviews: 8,
    newFileByteOrderMark: false,
    newFileLineEnding: '\n',
  });
  return {
    reviews,
    store,
    stage: async (chatId: string, withOrigin = true) => {
      const proposal = await compiler.proposeStructured({
        files: [
          {
            operation: EditOperation.CREATE,
            path: `${chatId}.txt`,
            new_path: null,
            base_revision: null,
            content: 'proposed',
            byte_order_mark: null,
            edits: [],
          },
        ],
      });
      await reviews.stage({
        ...proposal,
        ...(withOrigin ? { origin: { chatId, accountProvider: 'fixture', accountId: 'account' } } : {}),
      });
      return { proposalId: proposal.id, itemId: proposal.files[0]!.items[0]!.id };
    },
  };
}

describe(ProviderDesktopRuntime, () => {
  it('keeps the latest account catalog when an older discovery finishes later', async () => {
    const harness = await fixture(async () => {});
    const first = harness.backend.accounts[0]!;
    const second = { ...first, id: 'second', label: 'Second' };
    Object.defineProperty(harness.backend, 'accounts', { value: [first, second] });
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    harness.backend.listModels = async account => {
      if (account.id === first.id) await gate;
      return [{ slug: `${account.id}-model`, name: account.id }];
    };
    try {
      const pending = harness.runtime.handle({
        type: Command.SELECT_ACCOUNT,
        accountProvider: 'fixture',
        accountId: first.id,
      });
      await harness.runtime.handle({ type: Command.SELECT_ACCOUNT, accountProvider: 'fixture', accountId: second.id });
      release();
      await pending;
      expect(await harness.runtime.snapshot()).toMatchObject({
        selectedAccount: { id: second.id },
        selectedModel: 'second-model',
        models: [{ slug: 'second-model' }],
      });
      await harness.runtime.handle({ type: Command.SELECT_MODEL, model: 'second-model' });
      await expect(harness.runtime.handle({ type: Command.SELECT_MODEL, model: 'account-model' })).rejects.toThrow(
        'available model',
      );
    } finally {
      release();
      await harness.runtime.dispose();
    }
  });

  it('correlates the created chat with its request while ordinary chat updates remain uncorrelated', async () => {
    const harness = await fixture(async () => {});
    try {
      await harness.runtime.handle({
        type: Command.CREATE_CHAT,
        creationId: 'create-choice',
        accountProvider: 'fixture',
        accountId: 'account',
        model: 'model',
      });
      const created = harness.events.filter(
        event => event.type === GlyphHostEventType.CHAT_UPDATED && event.creationId === 'create-choice',
      );
      expect(created).toHaveLength(1);
      const event = created[0]!;
      if (event.type !== GlyphHostEventType.CHAT_UPDATED) throw new Error('Expected chat');
      expect(event.chat.id).not.toBe(harness.chatId);
      await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: event.chat.id });
      expect(harness.events.at(-1)).toMatchObject({
        type: GlyphHostEventType.CHAT_UPDATED,
        chat: { id: event.chat.id },
      });
      expect(harness.events.at(-1)).not.toHaveProperty('creationId');
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('totals saved turns per chat and replaces totals on repeated open, including missing reports', async () => {
    let reports = 0;
    const harness = await fixture(async () => (++reports === 2 ? null : usage));
    const other = await harness.glyph.createChat(harness.glyph.accounts[0]!, { slug: 'model', name: 'Model' });
    try {
      for (const [index, chatId] of [harness.chatId, harness.chatId, other.id, harness.chatId].entries()) {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId,
          runId: `run-${index}`,
          text: 'Continue',
          attachments: [],
        });
        await vi.waitFor(async () =>
          expect((await harness.runtime.snapshot()).runs[index]?.status).toBe(GlyphRunStatus.COMPLETED),
        );
      }
      const expected = {
        inputTokens: 4,
        outputTokens: 6,
        cachedInputTokens: 0,
        reasoningTokens: 2,
        totalTokens: 10,
        unreportedTurns: 1,
      };
      for (let i = 0; i < 2; i++) {
        await harness.runtime.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
        expect((await harness.runtime.snapshot()).usageByChat).toEqual({
          [harness.chatId]: expected,
          [other.id]: { ...usage, unreportedTurns: 0 },
        });
      }
      expect(harness.saved.get(harness.chatId)?.transcript.map(turn => turn.usage)).toEqual([usage, undefined, usage]);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('does not publish or count a completed provider result when its transcript checkpoint fails', async () => {
    const harness = await fixture(async () => {});
    const save = harness.store.save;
    harness.store.save = async () => {
      throw new Error('disk unavailable');
    };
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'failed-save',
        text: 'First',
        attachments: [],
      });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.FAILED),
      );
      expect(harness.events.filter(event => event.type === GlyphHostEventType.USAGE)).toEqual([]);
      expect(harness.saved.get(harness.chatId)?.transcript).toHaveLength(0);
      harness.store.save = save;
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'saved',
        text: 'Next',
        attachments: [],
      });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[1]?.status).toBe(GlyphRunStatus.COMPLETED),
      );
      expect((await harness.runtime.snapshot()).usageByChat?.[harness.chatId]).toEqual({
        ...usage,
        unreportedTurns: 0,
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('keeps tool call order stable and restores compact progress from completed turns', async () => {
    const harness = await fixture(async options => {
      for (const [callId, phase] of [
        ['first', ToolActivityPhase.STARTED],
        ['second', ToolActivityPhase.STARTED],
        ['second', ToolActivityPhase.FAILED],
        ['first', ToolActivityPhase.COMPLETED],
      ] as const)
        options.onToolActivity?.({
          callId,
          name: 'read',
          phase,
          arguments: '{}',
          output: 'large output is not copied into transcript',
        });
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'tools',
        text: 'Read',
        attachments: [],
      });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED),
      );
      const expected = [
        { id: 'first', name: 'read', status: 'completed' },
        { id: 'second', name: 'read', status: 'failed' },
      ];
      expect((await harness.runtime.snapshot()).runs[0]?.tools).toMatchObject(expected);
      expect(harness.saved.get(harness.chatId)?.transcript[0]?.tools).toEqual([
        { callId: 'first', name: 'read', phase: ToolActivityPhase.COMPLETED },
        { callId: 'second', name: 'read', phase: ToolActivityPhase.FAILED },
      ]);
      const restored = new ProviderDesktopRuntime({
        glyph: harness.glyph,
        interactions: new DesktopInteractionBroker(() => {}),
        shellSessions: harness.shells,
        emit: () => {},
        ownerWindowId: 'owner',
      });
      await restored.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
      await restored.handle({ type: Command.OPEN_CHAT, chatId: harness.chatId });
      const snapshot = await restored.snapshot();
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.runs[0]?.tools).toEqual(expected);
      expect(snapshot.usageByChat?.[harness.chatId]).toEqual({ ...usage, unreportedTurns: 0 });
      await restored.dispose();
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('leaves ownerless legacy receipts for explicit workspace-wide delivery instead of attributing them to concurrent chats', async () => {
    const { reviews, stage } = reviewFixture();
    const harness = await fixture(async () => {}, 'owner', reviews);
    const proposal = await stage(harness.chatId, false);
    await reviews.rejectInReview(proposal.proposalId, proposal.itemId);
    const account = harness.glyph.accounts[0]!;
    const other = await harness.glyph.createChat(account, { slug: 'model', name: 'Model' });
    try {
      await Promise.all(
        [harness.chatId, other.id].map(chatId =>
          harness.runtime.handle({
            type: Command.SEND,
            chatId,
            runId: chatId,
            text: 'Continue',
            attachments: [],
          }),
        ),
      );
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs.map(run => run.status)).toEqual([
          GlyphRunStatus.COMPLETED,
          GlyphRunStatus.COMPLETED,
        ]),
      );
      expect(harness.recorded).toEqual([[], []]);
      expect(reviews.pendingResults).toHaveLength(1);
      await harness.glyph.commitReviewResults(harness.glyph.openChat(harness.chatId, account));
      expect(harness.recorded.map(events => events.length)).toEqual([1, 0]);
      expect(reviews.pendingResults).toEqual([]);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('retries a cancelled receipt save before the next turn without losing or duplicating the durable decision', async () => {
    const { reviews, stage } = reviewFixture();
    const send = vi.fn(async () => {});
    const harness = await fixture(send, 'owner', reviews);
    const proposal = await stage(harness.chatId);
    await reviews.rejectInReview(proposal.proposalId, proposal.itemId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const originalSave = harness.store.save;
    let attempts = 0;
    harness.store.save = async record => {
      attempts++;
      if (attempts === 1) {
        await gate;
        throw new Error('Temporary receipt storage failure');
      }
      await originalSave(record);
    };
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'cancelled',
        text: 'First',
        attachments: [],
      });
      await vi.waitFor(() => expect(attempts).toBe(1));
      await harness.runtime.handle({ type: Command.CANCEL_RUN, chatId: harness.chatId, runId: 'cancelled' });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED),
      );
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'retry',
        text: 'Retry',
        attachments: [],
      });
      expect(send).not.toHaveBeenCalled();
      release();
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[1]?.status).toBe(GlyphRunStatus.COMPLETED),
      );
      expect(send).toHaveBeenCalledOnce();
      expect(harness.recorded[0]).toHaveLength(1);
      expect(harness.saved.get(harness.chatId)?.providerState.data).toEqual(harness.recorded[0]);
      expect(reviews.pendingResults).toEqual([]);
    } finally {
      release();
      await harness.runtime.dispose();
    }
  });

  it.each(['question', 'approval'] as const)(
    'continues another chat while a review receipt waits behind its owner’s %s',
    async waitingOn => {
      const { reviews, stage } = reviewFixture();
      let owner = '';
      const calls: string[] = [];
      const harness = await fixture(
        async (options, interactions) => {
          const chat = options.toolContext!.chat!.id;
          calls.push(chat);
          if (chat !== owner) return;
          if (waitingOn === 'approval') {
            await interactions.presentShellPermission(
              { command: 'true', workingDirectory: '/project' },
              options.signal,
            );
            return;
          }
          await interactions.present(
            {
              questions: [
                {
                  id: 'q',
                  prompt: 'Continue?',
                  allowMultiple: false,
                  options: [{ id: 'yes', label: 'Yes' }],
                },
              ],
            },
            options.signal,
          );
        },
        'owner',
        reviews,
      );
      owner = harness.chatId;
      const other = await harness.glyph.createChat(harness.glyph.accounts[0]!, { slug: 'model', name: 'Model' });
      const proposal = await stage(owner);
      let deciding: Promise<void> | undefined;
      try {
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: owner,
          runId: 'owner-run',
          text: 'Wait',
          attachments: [],
        });
        await vi.waitFor(async () =>
          expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(
            waitingOn === 'question' ? GlyphRunStatus.WAITING_FOR_QUESTION : GlyphRunStatus.WAITING_FOR_APPROVAL,
          ),
        );
        deciding = harness.runtime.handle({ type: Command.REJECT_PROPOSAL_ITEM, chatId: owner, ...proposal });
        await vi.waitFor(() => expect(reviews.pendingResults).toHaveLength(1));
        await harness.runtime.handle({
          type: Command.SEND,
          chatId: other.id,
          runId: 'other-run',
          text: 'Independent work',
          attachments: [],
        });
        await vi.waitFor(async () =>
          expect((await harness.runtime.snapshot()).runs.find(run => run.runId === 'other-run')?.status).toBe(
            GlyphRunStatus.COMPLETED,
          ),
        );
        expect(calls).toEqual([owner, other.id]);
        expect(harness.recorded[1]).toEqual([]);
        expect(reviews.pendingResults).toHaveLength(1);
        await harness.runtime.handle({ type: Command.CANCEL_RUN, chatId: owner, runId: 'owner-run' });
        await deciding;
        expect(harness.recorded[0]).toHaveLength(1);
        expect(harness.saved.get(owner)?.providerState.data).toEqual(harness.recorded[0]);
        expect(reviews.pendingResults).toEqual([]);
      } finally {
        await harness.runtime.dispose();
        await deciding;
      }
    },
  );

  it('cancels a turn during receipt persistence while teardown still drains the admitted save', async () => {
    const { reviews, stage } = reviewFixture();
    const send = vi.fn(async () => {});
    const harness = await fixture(send, 'owner', reviews);
    const proposal = await stage(harness.chatId);
    await reviews.rejectInReview(proposal.proposalId, proposal.itemId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const originalSave = harness.store.save;
    let saving = false;
    harness.store.save = async record => {
      saving = true;
      await gate;
      await originalSave(record);
    };
    const close = vi.spyOn(harness.store, 'dispose');
    let stopping: Promise<void> | undefined;
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Continue',
        attachments: [],
      });
      await vi.waitFor(() => expect(saving).toBe(true));
      await harness.runtime.handle({ type: Command.CANCEL_RUN, chatId: harness.chatId, runId: 'run' });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED),
      );
      expect(send).not.toHaveBeenCalled();
      expect(reviews.pendingResults).toHaveLength(1);
      stopping = harness.runtime.dispose();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(close).not.toHaveBeenCalled();
      release();
      await stopping;
      expect(close).toHaveBeenCalledOnce();
      expect(reviews.pendingResults).toEqual([]);
      expect(harness.saved.get(harness.chatId)?.providerState.data).toEqual(harness.recorded[0]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      release();
      await (stopping ?? harness.runtime.dispose());
    }
  });

  it('cancels before a pending review checkpoint finishes without starting late inference', async () => {
    const { reviews, store, stage } = reviewFixture();
    const send = vi.fn(async () => {});
    const harness = await fixture(send, 'owner', reviews);
    const proposal = await stage(harness.chatId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    store.save.mockImplementation(async () => gate);
    const rejecting = reviews.rejectInReview(proposal.proposalId, proposal.itemId);
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Continue',
        attachments: [],
      });
      await harness.runtime.handle({ type: Command.CANCEL_RUN, chatId: harness.chatId, runId: 'run' });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED),
      );
      expect(send).not.toHaveBeenCalled();
      release();
      await rejecting;
      await harness.runtime.dispose();
      expect(send).not.toHaveBeenCalled();
      expect(reviews.pendingResults).toHaveLength(1);
    } finally {
      release();
      await rejecting;
      await harness.runtime.dispose();
    }
  });

  it.each(['detach', 'revoke trust'] as const)(
    'allows the host to %s during model discovery without waiting for its response',
    async transition => {
      const first = await fixture(async () => {});
      const nextWindow = transition === 'detach' ? 'peer' : 'owner';
      const replacement = await fixture(async () => {}, nextWindow);
      const runtimes = [first.runtime, replacement.runtime];
      const host = new GlyphDesktopHost({ create: async () => runtimes.shift()! });
      const events: GlyphHostEvent[] = [];
      const identity = { profileId: 'fixture', windowId: 'owner', workspaceId: 'project' };
      const roots = [{ name: 'project', uri: 'file:///project', canonicalPath: '/project' }];
      let request = 0;
      const receive = (windowId: string, command: GlyphWorkbenchCommand) =>
        host.receive(windowId, {
          ...identity,
          windowId,
          protocolVersion: GLYPH_DESKTOP_PROTOCOL_VERSION,
          requestId: String(++request),
          command,
        });
      host.connect('owner', identity, envelope => events.push(envelope.event));
      await receive('owner', { type: Command.ATTACH_WORKSPACE, roots, trusted: true });
      let release!: () => void;
      let discoverySignal: AbortSignal | undefined;
      first.backend.listModels = (_account, signal) =>
        new Promise((resolve, reject) => {
          discoverySignal = signal;
          const abort = () => reject(signal?.reason);
          release = () => {
            signal?.removeEventListener('abort', abort);
            resolve([{ slug: 'next', name: 'Next' }]);
          };
          signal?.addEventListener('abort', abort, { once: true });
        });
      const discovering = receive('owner', {
        type: Command.SELECT_ACCOUNT,
        accountProvider: 'fixture',
        accountId: 'account',
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      let transitioned = false;
      const changing = receive(
        'owner',
        transition === 'detach' ? { type: Command.DETACH } : { type: Command.ATTACH_WORKSPACE, roots, trusted: false },
      ).then(() => {
        transitioned = true;
      });
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(discoverySignal?.aborted).toBe(true);
        expect(transitioned).toBe(true);
        if (transition === 'detach') {
          host.connect('peer', { ...identity, windowId: 'peer' }, envelope => events.push(envelope.event));
          await receive('peer', { type: Command.ATTACH_WORKSPACE, roots, trusted: true });
        }
        expect(events.filter(event => event.type === GlyphHostEventType.INITIAL_STATE).at(-1)).toMatchObject({
          state: { ownerWindowId: nextWindow, readOnly: false },
        });
        expect(first.shells.dispose).toHaveBeenCalledOnce();
      } finally {
        release();
        await Promise.all([discovering, changing]);
        await host.dispose();
        await replacement.runtime.dispose();
      }
    },
  );

  it.each(
    ([Command.SELECT_ACCOUNT, Command.CREATE_CHAT] as const).flatMap(type =>
      (['dispose', 'disconnect'] as const).map(retirement => ({ type, retirement })),
    ),
  )('cancels $type discovery on $retirement before closing its dependencies', async ({ type, retirement }) => {
    const harness = await fixture(async () => {});
    let release!: () => void;
    let discoverySignal: AbortSignal | undefined;
    const get = vi.fn<HttpClient['get']>(
      (_url, options) =>
        new Promise((resolve, reject) => {
          discoverySignal = options?.signal;
          const abort = () => reject(discoverySignal?.reason);
          release = () => {
            discoverySignal?.removeEventListener('abort', abort);
            resolve({
              ok: true,
              status: 200,
              headers: new Headers(),
              body: {
                models: [{ slug: 'next', display_name: 'Next', visibility: 'list' }],
              },
            });
          };
          if (discoverySignal?.aborted) abort();
          else discoverySignal?.addEventListener('abort', abort, { once: true });
        }),
    );
    const catalog = new OpenAIModelCatalog(
      {
        issuer: 'https://auth.example.test',
        resource: 'https://api.example.test',
        scopes: 'openid',
        planScope: 'plan',
        requestTimeoutMs: 30_000,
      },
      { get, post: vi.fn() },
    );
    harness.backend.listModels = (_account, signal) => catalog.list('fixture-token', signal);
    const command = { type, accountProvider: 'fixture', accountId: 'account', model: 'next' };
    let outcome: 'pending' | 'completed' | 'cancelled' = 'pending';
    const pending = harness.runtime.handle(command).then(
      () => {
        outcome = 'completed';
      },
      () => {
        outcome = 'cancelled';
      },
    );
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    let stopped = false;
    const stopping = (
      retirement === 'dispose' ? harness.runtime.dispose() : harness.runtime.connectionLost('owner')
    ).then(() => {
      stopped = true;
    });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(discoverySignal?.aborted).toBe(true);
      expect(outcome).toBe('cancelled');
      expect(stopped).toBe(true);
      expect(harness.saved.size).toBe(1);
      expect((await harness.runtime.snapshot()).selectedModel).toBe('model');
    } finally {
      release();
      await Promise.all([pending, stopping]);
      if (retirement !== 'dispose') await harness.runtime.dispose();
    }
  });

  it.each([Command.SELECT_ACCOUNT, Command.CREATE_CHAT] as const)(
    'ignores a late discovery result after its owner disconnects during %s',
    async type => {
      const harness = await fixture(async () => {});
      let release!: () => void;
      harness.backend.listModels = () =>
        new Promise(resolve => {
          release = () => resolve([{ slug: 'next', name: 'Next' }]);
        });
      const pending = harness.runtime.handle({ type, accountProvider: 'fixture', accountId: 'account', model: 'next' });
      const result = pending.then(
        () => 'completed',
        () => 'cancelled',
      );
      try {
        await harness.runtime.connectionLost('owner');
        release();
        expect(await result).toBe('cancelled');
        expect(harness.saved.size).toBe(1);
        expect((await harness.runtime.snapshot()).selectedModel).toBe('model');
      } finally {
        release();
        await result;
        await harness.runtime.dispose();
      }
    },
  );

  it('lets a reconnected owner discover models again and ignores a peer disconnect', async () => {
    const harness = await fixture(async () => {});
    const signals: (AbortSignal | undefined)[] = [];
    harness.backend.listModels = async (_account, signal) => {
      signals.push(signal);
      signal?.throwIfAborted();
      return [{ slug: 'next', name: 'Next' }];
    };
    const command = { type: Command.SELECT_ACCOUNT, accountProvider: 'fixture', accountId: 'account' } as const;
    try {
      await harness.runtime.handle(command);
      await harness.runtime.connectionLost('peer');
      expect(signals[0]?.aborted).toBe(false);
      await harness.runtime.connectionLost('owner');
      expect(signals[0]?.aborted).toBe(true);
      await harness.runtime.handle(command);
      expect(signals[1]?.aborted).toBe(false);
      expect(signals[1]).not.toBe(signals[0]);
      expect((await harness.runtime.snapshot()).selectedModel).toBe('next');
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('finishes an admitted chat checkpoint before storage closes and suppresses its disconnected notification', async () => {
    const harness = await fixture(async () => {});
    const save = harness.store.save.bind(harness.store);
    let release!: () => void;
    const saving = vi.spyOn(harness.store, 'save').mockImplementation(
      record =>
        new Promise<void>(resolve => {
          release = () => {
            void save(record).then(resolve);
          };
        }),
    );
    const closed = vi.spyOn(harness.store, 'dispose');
    const eventCount = harness.events.length;
    const pending = harness.runtime.handle({
      type: Command.CREATE_CHAT,
      accountProvider: 'fixture',
      accountId: 'account',
      model: 'model',
    });
    const result = pending.then(
      () => 'completed',
      () => 'cancelled',
    );
    await vi.waitFor(() => expect(saving).toHaveBeenCalledOnce());
    const stopping = harness.runtime.dispose();
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(closed).not.toHaveBeenCalled();
    } finally {
      release();
      await stopping;
    }
    expect(await result).toBe('cancelled');
    expect(harness.saved.size).toBe(2);
    expect(closed).toHaveBeenCalledOnce();
    expect(harness.events).toHaveLength(eventCount);
  });

  it('shares teardown across repeated disposal calls so dependencies close once', async () => {
    const harness = await fixture(async () => {});
    const close = vi.spyOn(harness.backend, 'dispose');
    await Promise.all([harness.runtime.dispose(), harness.runtime.dispose()]);
    expect(close).toHaveBeenCalledOnce();
    expect(harness.shells.dispose).toHaveBeenCalledOnce();
  });
  it('cancels an active provider turn and terminates background shells during trust-boundary disposal', async () => {
    const harness = await fixture(async options => {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    });
    await harness.runtime.handle({
      type: Command.SEND,
      chatId: harness.chatId,
      runId: 'active',
      text: 'Continue',
      attachments: [],
    });
    await harness.runtime.dispose();
    expect(harness.shells.dispose).toHaveBeenCalledOnce();
    expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.CANCELLED);
  });

  it('drains an admitted proposal decision before disposing its chat storage', async () => {
    const harness = await fixture(async () => {});
    let finish!: () => void;
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    const disposed = vi.spyOn(harness.glyph, 'dispose');
    const checkpoint = vi.spyOn(harness.glyph, 'renameChat');
    const decisions = harness.runtime as unknown as { decideProposal(): Promise<void> };
    vi.spyOn(decisions, 'decideProposal').mockImplementation(async () => {
      await gate;
      await harness.glyph.renameChat(harness.chatId, 'Decision checkpoint');
    });
    const decision = harness.runtime.handle({
      type: Command.ACCEPT_PROPOSAL_ITEM,
      chatId: harness.chatId,
      proposalId: 'proposal',
      itemId: 'item',
    });
    const stopping = harness.runtime.dispose();
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(disposed).not.toHaveBeenCalled();
    } finally {
      finish();
      await decision;
      await stopping;
    }
    expect(checkpoint.mock.invocationCallOrder[0]).toBeLessThan(disposed.mock.invocationCallOrder[0]!);
  });

  it('streams a real application turn, persists its transcript, and includes reasoning, tools, and usage in recovery state', async () => {
    const harness = await fixture(async options => {
      options.onText('Answer');
      options.onReasoningSummary?.('Summary');
      options.onToolActivity?.({
        phase: ToolActivityPhase.COMPLETED,
        callId: 'tool',
        name: 'read',
        arguments: '{}',
        output: 'file',
      });
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Question',
        attachments: [],
      });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED),
      );
      expect(harness.saved.get(harness.chatId)?.transcript).toMatchObject([
        { userText: 'Question', assistantText: 'Answer', reasoningSummary: 'Summary' },
      ]);
      expect((await harness.runtime.snapshot()).runs[0]).toMatchObject({
        text: 'Answer',
        reasoning: 'Summary',
        tools: [{ id: 'tool' }],
      });
      expect((await harness.runtime.snapshot()).usageByChat?.[harness.chatId]).toEqual({
        ...usage,
        unreportedTurns: 0,
      });
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('keeps a model question recoverable until the matching answer resumes the same run', async () => {
    const harness = await fixture(async (options, interactions) => {
      await interactions.present(
        {
          questions: [
            {
              id: 'choice',
              prompt: 'Which?',
              allowMultiple: false,
              options: [
                { id: 'one', label: 'One' },
                { id: 'two', label: 'Two' },
              ],
            },
          ],
        },
        options.signal,
      );
      options.onText('Answered');
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Ask me',
        attachments: [],
      });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_QUESTION),
      );
      const question = (await harness.runtime.snapshot()).runs[0]!.question!;
      await harness.runtime.handle({
        type: Command.ANSWER_QUESTION,
        chatId: harness.chatId,
        runId: 'run',
        questionId: question.id,
        answer: { answers: [{ questionId: 'choice', type: QuestionAnswerType.SELECTION, optionIds: ['one'] }] },
      });
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.COMPLETED),
      );
      expect((await harness.runtime.snapshot()).runs[0]?.question).toBeUndefined();
      expect(harness.events.some(event => event.type === GlyphHostEventType.QUESTION)).toBe(true);
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('prevents competing runs in one chat and cancels waiting work when the owning window disconnects', async () => {
    const harness = await fixture(async (options, interactions) => {
      await interactions.presentShellPermission({ command: 'true', workingDirectory: '/project' }, options.signal);
    });
    try {
      await harness.runtime.handle({
        type: Command.SEND,
        chatId: harness.chatId,
        runId: 'run',
        text: 'Wait',
        attachments: [],
      });
      await expect(
        harness.runtime.handle({
          type: Command.SEND,
          chatId: harness.chatId,
          runId: 'other',
          text: 'Conflict',
          attachments: [],
        }),
      ).rejects.toThrow('active run');
      await vi.waitFor(async () =>
        expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL),
      );
      await harness.runtime.connectionLost('peer');
      expect((await harness.runtime.snapshot()).runs[0]?.status).toBe(GlyphRunStatus.WAITING_FOR_APPROVAL);
      await harness.runtime.connectionLost('owner');
      expect((await harness.runtime.snapshot()).runs[0]).toMatchObject({ status: GlyphRunStatus.CANCELLED });
      expect((await harness.runtime.snapshot()).runs[0]?.approval).toBeUndefined();
    } finally {
      await harness.runtime.dispose();
    }
  });

  it('rejects unavailable accounts and models before creating a persistent chat', async () => {
    const harness = await fixture(async () => {});
    try {
      await expect(
        harness.runtime.handle({
          type: Command.CREATE_CHAT,
          accountProvider: 'fixture',
          accountId: 'another',
          model: 'model',
        }),
      ).rejects.toThrow('Connect an account');
      await expect(
        harness.runtime.handle({
          type: Command.CREATE_CHAT,
          accountProvider: 'fixture',
          accountId: 'account',
          model: 'missing',
        }),
      ).rejects.toThrow('unavailable');
      expect(harness.saved.size).toBe(1);
    } finally {
      await harness.runtime.dispose();
    }
  });
});
