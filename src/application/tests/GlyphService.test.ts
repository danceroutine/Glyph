import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatAccount } from '#src/chat/ChatAccount.js';
import type { ChatBackend } from '#src/chat/ChatBackend.js';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import { toChatRequest } from '#src/chat/ChatRequest.js';
import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import { ChatSessionManager } from '#src/chat/sessions/ChatSessionManager.js';
import type { ChatSessionRecord } from '#src/chat/sessions/ChatSessionRecord.js';
import type { ChatSessionStore } from '#src/chat/sessions/ChatSessionStore.js';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import type { ChatResponsePart } from '#src/chat/ChatResponsePart.js';
import { ChatResponsePartType } from '#src/chat/ChatResponsePartType.js';
import { ToolActivityPhase } from '#src/chat/ToolActivityPhase.js';
import type { TurnResult } from '#src/chat/TurnResult.js';
import type { Logger } from '#src/observability/Logger.js';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ProjectContextResolver } from '#src/project/context/ProjectContextResolver.js';
import { GlyphService } from '#src/application/GlyphService.js';
import type { ProposalReviewManager } from '#src/editing/reviews/ProposalReviewManager.js';
import { EditDecisionState } from '#src/editing/reviews/EditDecisionState.js';
import { EditReviewItemKind } from '#src/editing/reviews/EditReviewItemKind.js';
import type { EditReviewResult } from '#src/editing/reviews/EditReviewResult.js';
import { AgentModeID } from '#src/chat/AgentMode.js';
import type { ChatSessionSummary } from '#src/chat/sessions/ChatSessionRecord.js';
import type { ContextAttachmentService } from '#src/context/attachments/ContextAttachmentService.js';
import { PlanError } from '#src/planning/PlanError.js';
import type { PlanUpdate } from '#src/planning/PlanSchema.js';

const account: ChatAccount = {
  provider: 'fixture',
  id: 'account-1',
  label: 'developer@example.com',
  detail: 'workspace',
  connected: true,
  inferenceAccess: true,
};

class FakeProvider implements ChatProvider {
  readonly model = 'model-a';
  readonly reset = vi.fn();
  readonly recordContext = vi.fn();
  readonly prompts: string[] = [];
  private state: ChatProviderState = { provider: 'fake', version: 1, data: null };

  exportState(): ChatProviderState {
    return this.state;
  }

  restoreState(state: ChatProviderState): void {
    this.state = state;
  }

  async send(
    input: Parameters<ChatProvider['send']>[0],
    options: Parameters<ChatProvider['send']>[1],
  ): Promise<TurnResult> {
    const request = toChatRequest(input);
    this.prompts.push(request.text);
    options.onTrace?.({ sequence: 1, timestamp: 'now', kind: 'request', data: { text: request.text } });
    options.onToolActivity?.({
      phase: ToolActivityPhase.STARTED,
      namespace: 'project',
      name: 'read_project_file',
      callId: 'call',
      arguments: '{}',
    });
    options.onReasoningSummary?.('Looked up the relevant project context.');
    options.onText('answer');
    return {
      responseId: 'response',
      usage: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningTokens: 1, totalTokens: 5 },
    };
  }
}

class FakeBackend implements ChatBackend {
  readonly presentation = {
    name: 'Fixture',
    welcome: 'Glyph | Fixture',
    usageDescription: 'Fixture usage',
    accountsHeading: 'Fixture accounts',
    addAccountLabel: 'Add account',
    activeAccessLabel: 'Fixture access',
  };
  readonly accounts = [account];
  readonly initialize = vi.fn(async () => {});
  readonly dispose = vi.fn(async () => {});
  readonly signIn = vi.fn(async () => account);
  readonly acknowledgeNotice = vi.fn(async () => {});
  readonly listModels = vi.fn(async () => [{ slug: 'model-a', name: 'Model A' }]);
  readonly createProvider = vi.fn(
    (_account: ChatAccount, _model: { slug: string; name: string }, _state?: ChatProviderState) =>
      this.providerFactory(),
  );
  readonly logout = vi.fn(async () => true);

  constructor(private readonly providerFactory: () => ChatProvider = () => new FakeProvider()) {}

  redact(message: string): string {
    return message.replaceAll('secret', '[REDACTED]');
  }
}

function logger(trace: Logger['trace'] = async () => {}): Logger {
  const result: Logger = {
    destination: '/config/trace.log',
    trace,
    forNamespace: () => result,
    debug: async () => {},
    info: async () => {},
    warn: async () => {},
    error: async () => {},
  };
  return result;
}

describe(GlyphService, () => {
  describe(GlyphService.prototype.initialize, () => {
    it('initializes and disposes the resident file index with the account-store lifecycle', async () => {
      const backend = new FakeBackend();
      const fileSearch: WorkspacePathIndex = {
        initialize: vi.fn(async () => ({
          root: '/project',
          fileCount: 1,
          fromCache: false,
          truncated: false,
          durationMilliseconds: 1,
        })),
        search: vi.fn(),
        glob: vi.fn(),
        searchContents: vi.fn(),
        refresh: vi.fn(),
        dispose: vi.fn(async () => {}),
      };
      const service = new GlyphService(backend, logger(), {}, undefined, undefined, fileSearch);

      await service.initialize();
      await service.initialize();
      await service.dispose();
      await service.dispose();

      expect(fileSearch.initialize).toHaveBeenCalledOnce();
      expect(fileSearch.dispose).toHaveBeenCalledOnce();
      expect(backend.initialize).toHaveBeenCalledOnce();
      expect(backend.dispose).toHaveBeenCalledOnce();
    });

    it('disposes a failed file index and releases the account lock before surfacing startup failure', async () => {
      const backend = new FakeBackend();
      const startupFailure = new Error('native index could not start');
      const fileSearch: WorkspacePathIndex = {
        initialize: vi.fn(async () => {
          throw startupFailure;
        }),
        search: vi.fn(),
        glob: vi.fn(),
        searchContents: vi.fn(),
        refresh: vi.fn(),
        dispose: vi.fn(async () => {}),
      };
      const service = new GlyphService(backend, logger(), {}, undefined, undefined, fileSearch);

      await expect(service.initialize()).rejects.toBe(startupFailure);

      expect(fileSearch.dispose).toHaveBeenCalledOnce();
      expect(backend.dispose).toHaveBeenCalledOnce();
      await service.dispose();
      expect(backend.dispose).toHaveBeenCalledOnce();
    });

    it('restores persisted chats without indexing or reconciling an untrusted workspace', async () => {
      const fileSearch = { initialize: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
      const reviews = { initialize: vi.fn(async () => {}) };
      const sessions = { initialize: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
      const service = new GlyphService(
        new FakeBackend(),
        logger(),
        {},
        reviews as unknown as ProposalReviewManager,
        undefined,
        fileSearch as unknown as WorkspacePathIndex,
        sessions as unknown as ChatSessionManager,
      );

      await service.initialize({ workspaceTrusted: false });

      expect(sessions.initialize).toHaveBeenCalledOnce();
      expect(reviews.initialize).toHaveBeenCalledWith({ reconcileWorkspace: false });
      expect(fileSearch.initialize).not.toHaveBeenCalled();
    });

    it('closes chat storage and the backend without touching an unstarted index when recovery fails', async () => {
      const failure = new Error('recovery failed');
      const backend = new FakeBackend();
      const fileSearch = { initialize: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
      const reviews = {
        initialize: vi.fn(async () => {
          throw failure;
        }),
      };
      const sessions = { initialize: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
      const service = new GlyphService(
        backend,
        logger(),
        {},
        reviews as unknown as ProposalReviewManager,
        undefined,
        fileSearch as unknown as WorkspacePathIndex,
        sessions as unknown as ChatSessionManager,
      );

      await expect(service.initialize()).rejects.toBe(failure);

      expect(fileSearch.dispose).not.toHaveBeenCalled();
      expect(sessions.dispose).toHaveBeenCalledOnce();
      expect(backend.dispose).toHaveBeenCalledOnce();
    });

    it('reports the startup failure together with every incomplete cleanup', async () => {
      const startup = new Error('index failed');
      const indexCleanup = new Error('index cleanup failed');
      const chatCleanup = new Error('chat cleanup failed');
      const backendCleanup = new Error('backend cleanup failed');
      const backend = new FakeBackend();
      backend.dispose.mockRejectedValue(backendCleanup);
      const fileSearch = {
        initialize: vi.fn(async () => {
          throw startup;
        }),
        dispose: vi.fn(async () => {
          throw indexCleanup;
        }),
      };
      const sessions = {
        initialize: vi.fn(async () => {}),
        dispose: vi.fn(async () => {
          throw chatCleanup;
        }),
      };
      const service = new GlyphService(
        backend,
        logger(),
        {},
        undefined,
        undefined,
        fileSearch as unknown as WorkspacePathIndex,
        sessions as unknown as ChatSessionManager,
      );

      const error = await service.initialize().catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).message).toBe(
        'Glyph initialization failed and resource cleanup was incomplete.',
      );
      expect((error as AggregateError).errors).toEqual([startup, indexCleanup, chatCleanup, backendCleanup]);
    });
  });

  describe(GlyphService.prototype.createConversation, () => {
    it('exposes request-scoped response parts through injected lifecycle ports', async () => {
      const provider = new FakeProvider();
      const backend = new FakeBackend(() => provider);
      const traces: unknown[] = [];
      const service = new GlyphService(
        backend,
        logger(async (_message, data) => {
          traces.push(data);
        }),
      );
      const parts: ChatResponsePart[] = [];

      await service.initialize();
      expect(await service.listModels(account)).toEqual([{ slug: 'model-a', name: 'Model A' }]);
      const conversation = service.createConversation(account, { slug: 'model-a', name: 'Model A' });
      const result = await conversation.send(
        'question',
        { push: part => parts.push(part) },
        new AbortController().signal,
      );
      conversation.reset();
      await service.dispose();

      expect(backend.initialize).toHaveBeenCalledOnce();
      expect(backend.dispose).toHaveBeenCalledOnce();
      expect(backend.createProvider).toHaveBeenCalledWith(account, { slug: 'model-a', name: 'Model A' }, undefined);
      expect(parts).toEqual([
        expect.objectContaining({ type: ChatResponsePartType.TOOL }),
        { type: ChatResponsePartType.REASONING_SUMMARY, value: 'Looked up the relevant project context.' },
        { type: ChatResponsePartType.TEXT, value: 'answer' },
      ]);
      expect(result.responseId).toBe('response');
      expect(service.usage.totalTokens).toBe(5);
      expect(traces[0]).toEqual([expect.objectContaining({ kind: 'request' })]);
      expect(provider.reset).toHaveBeenCalledOnce();
    });

    it('reports logger failures without discarding a completed turn', async () => {
      const service = new GlyphService(
        new FakeBackend(),
        logger(async () => {
          throw new Error('secret disk failure');
        }),
      );
      const conversation = service.createConversation(account, { slug: 'model-a', name: 'Model A' });
      const parts: ChatResponsePart[] = [];

      const result = await conversation.send(
        'question',
        { push: part => parts.push(part) },
        new AbortController().signal,
      );

      expect(result.responseId).toBe('response');
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: ChatResponsePartType.DIAGNOSTIC,
          message: 'Trace log write failed: [REDACTED] disk failure',
        }),
      );
    });

    it('creates isolated provider history for each host-owned conversation', async () => {
      const created: FakeProvider[] = [];
      const backend = new FakeBackend(() => {
        const provider = new FakeProvider();
        created.push(provider);
        return provider;
      });
      const service = new GlyphService(backend, logger());
      const first = service.createConversation(account, { slug: 'model-a', name: 'Model A' });
      const second = service.createConversation(account, { slug: 'model-a', name: 'Model A' });

      await first.send('first-session', { push: () => {} }, new AbortController().signal);
      await second.send('second-session', { push: () => {} }, new AbortController().signal);

      expect(created).toHaveLength(2);
      expect(created[0]?.prompts).toEqual(['first-session']);
      expect(created[1]?.prompts).toEqual(['second-session']);
    });

    it('leaves aggregate usage unchanged when a turn reports no usage', async () => {
      const provider = new FakeProvider();
      vi.spyOn(provider, 'send').mockResolvedValue({ responseId: 'response', usage: null });
      const service = new GlyphService(new FakeBackend(() => provider), logger());
      const conversation = service.createConversation(account, { slug: 'model-a', name: 'Model A' });

      await conversation.send('question', { push: () => {} }, new AbortController().signal);

      expect(service.usage).toEqual({
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
      });
    });
  });

  describe('project chat sessions', () => {
    it('creates, names, lists, reuses, and renames durable chats through the headless service', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glyph-service-chats-'));
      await mkdir(join(root, '.git'));
      try {
        const chatStore = new MemoryChatSessionStore();
        const sessions = new ChatSessionManager(chatStore, await ProjectContextResolver.folder(root), () => 'chat-id');
        const backend = new FakeBackend();
        const service = new GlyphService(backend, logger(), {}, undefined, undefined, undefined, sessions);
        await service.initialize();

        const chat = await service.createChat(account, { slug: 'model-a', name: 'Model A' });
        await chat.send('Please review the project architecture', { push: () => {} }, new AbortController().signal);

        expect(service.listChats(account)).toEqual([
          expect.objectContaining({
            id: 'chat-id',
            title: 'Review Project Architecture',
            titleOrigin: 'generated',
            turnCount: 1,
          }),
        ]);
        expect(service.openChat('chat', account)).toBe(chat);
        expect(chat.transcript).toHaveLength(1);
        await expect(service.renameChat(chat.id, 'Architecture review')).resolves.toMatchObject({
          title: 'Architecture review',
          titleOrigin: 'human',
        });
        expect(() => service.openChat(chat.id, { ...account, id: 'someone-else' })).toThrow(
          'different provider account',
        );
        expect(backend.createProvider).toHaveBeenLastCalledWith(
          account,
          { slug: 'model-a', name: 'Model A' },
          undefined,
        );
        expect(backend.createProvider).toHaveBeenCalledTimes(1);
        await service.dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('routes each durable review decision to the chat that staged the proposal', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glyph-service-review-owner-'));
      try {
        const chatStore = new MemoryChatSessionStore();
        const ids = ['owner-chat', 'current-chat'];
        const sessions = new ChatSessionManager(chatStore, await ProjectContextResolver.folder(root), () =>
          ids.shift()!,
        );
        const providers: FakeProvider[] = [];
        const backend = new FakeBackend(() => {
          const provider = new FakeProvider();
          providers.push(provider);
          return provider;
        });
        const result = {
          schemaVersion: 1 as const,
          id: 'edit-review-result:proposal:item',
          reviewId: 'proposal',
          origin: { chatId: 'owner-chat', accountProvider: account.provider, accountId: account.id },
          items: [
            {
              itemId: 'item',
              fileId: 'file',
              kind: EditReviewItemKind.TEXT,
              decision: EditDecisionState.ACCEPTED,
              affectedPaths: ['src/App.tsx'],
              resultingRevision: 'revision-2',
            },
          ],
        };
        const reviews = {
          pendingResults: [result],
          flushPendingCheckpoint: vi.fn(async () => {}),
          initialize: vi.fn(async () => {}),
          acknowledgeResults: vi.fn(async () => {}),
        } as unknown as ProposalReviewManager;
        const service = new GlyphService(backend, logger(), {}, reviews, undefined, undefined, sessions);
        await service.initialize();
        await service.createChat(account, { slug: 'model-a', name: 'Model A' });
        const current = await service.createChat(account, { slug: 'model-a', name: 'Model A' });

        await service.commitReviewResults(current);

        expect(providers).toHaveLength(2);
        expect(providers[1]!.recordContext).not.toHaveBeenCalled();
        expect(providers[0]!.recordContext).toHaveBeenCalledWith([
          expect.objectContaining({ id: result.id, payload: result }),
        ]);
        expect(reviews.acknowledgeResults).toHaveBeenCalledWith([result.id]);
        await service.dispose();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe(GlyphService.prototype.setChatMode, () => {
    it('refuses to change the mode without chat storage', () => {
      const service = new GlyphService(new FakeBackend(), logger());

      expect(() => service.setChatMode('chat', AgentModeID.PLAN)).toThrow(
        new PlanError('Chat storage is unavailable.'),
      );
    });

    it('stores the selected mode for the chat', async () => {
      const summary = { id: 'chat', mode: AgentModeID.PLAN };
      const sessions = { setMode: vi.fn(async () => summary) };
      const service = new GlyphService(
        new FakeBackend(),
        logger(),
        {},
        undefined,
        undefined,
        undefined,
        sessions as unknown as ChatSessionManager,
      );

      await expect(service.setChatMode('chat', AgentModeID.PLAN)).resolves.toBe(summary);
      expect(sessions.setMode).toHaveBeenCalledWith('chat', AgentModeID.PLAN);
    });
  });

  describe(GlyphService.prototype.linkPlan, () => {
    it('refuses to link a plan without plan storage', () => {
      const service = new GlyphService(new FakeBackend(), logger());

      expect(() => service.linkPlan('chat', 'plan', 'target', 'Builder')).toThrow(
        new PlanError('Plan storage is unavailable.'),
      );
    });

    it('links the plan to the target chat in the requested role', async () => {
      const summary = { id: 'chat' };
      const sessions = { linkPlan: vi.fn(async () => summary) };
      const service = new GlyphService(
        new FakeBackend(),
        logger(),
        {},
        undefined,
        undefined,
        undefined,
        sessions as unknown as ChatSessionManager,
      );

      await expect(service.linkPlan('chat', 'plan', 'target', 'Reviewer')).resolves.toBe(summary);
      expect(sessions.linkPlan).toHaveBeenCalledWith('chat', 'plan', 'target', 'Reviewer');
    });
  });

  describe(GlyphService.prototype.updatePlan, () => {
    it('refuses to update a plan without plan storage', () => {
      const service = new GlyphService(new FakeBackend(), logger());
      const chat = chatSummary('chat');
      const update: PlanUpdate = {
        id: null,
        expectedRevision: null,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [],
      };

      expect(() => service.updatePlan(chat, update)).toThrow(new PlanError('Plan storage is unavailable.'));
    });

    it('saves the plan update for the chat', async () => {
      const chat = chatSummary('chat');
      const update: PlanUpdate = {
        id: null,
        expectedRevision: null,
        title: 'Plan',
        summary: 'Summary',
        markdown: '# Plan',
        todos: [],
      };
      const sessions = { updatePlan: vi.fn(async () => chat) };
      const service = new GlyphService(
        new FakeBackend(),
        logger(),
        {},
        undefined,
        undefined,
        undefined,
        sessions as unknown as ChatSessionManager,
      );

      await expect(service.updatePlan(chat, update)).resolves.toBe(chat);
      expect(sessions.updatePlan).toHaveBeenCalledWith(chat, update);
    });
  });

  describe('account and provider delegation', () => {
    it('exposes backend accounts, presentation, and trace destination', () => {
      const backend = new FakeBackend();
      const service = new GlyphService(backend, logger(), { traceEnabled: false });

      expect(service.accounts).toBe(backend.accounts);
      expect(service.providerPresentation).toBe(backend.presentation);
      expect(service.tracePath).toBe('/config/trace.log');
      expect(service.isTraceEnabled).toBe(false);
      expect(service.hasInferenceAccess(account)).toBe(true);
    });

    it('signs in without requesting inference access by default', async () => {
      const backend = new FakeBackend();
      const service = new GlyphService(backend, logger());

      await expect(service.signIn()).resolves.toBe(account);
      expect(backend.signIn).toHaveBeenCalledWith(undefined, { requestInferenceAccess: false }, undefined);
    });

    it('forwards an inference access request and authorization handler when signing in', async () => {
      const backend = new FakeBackend();
      const service = new GlyphService(backend, logger());
      const authorize = vi.fn(async () => {});

      await service.signIn(account, true, authorize);

      expect(backend.signIn).toHaveBeenCalledWith(account, { requestInferenceAccess: true }, authorize);
    });

    it('acknowledges an account notice with the backend', async () => {
      const backend = new FakeBackend();
      const service = new GlyphService(backend, logger());

      await service.acknowledgeAccountNotice(account);

      expect(backend.acknowledgeNotice).toHaveBeenCalledWith(account);
    });

    it('signs out through the backend', async () => {
      const backend = new FakeBackend();
      backend.logout.mockResolvedValue(false);
      const service = new GlyphService(backend, logger());

      await expect(service.logout(account)).resolves.toBe(false);
      expect(backend.logout).toHaveBeenCalledWith(account);
    });

    it('redacts messages with the backend policy', () => {
      const service = new GlyphService(new FakeBackend(), logger());

      expect(service.redact('a secret value')).toBe('a [REDACTED] value');
    });
  });

  describe(GlyphService.prototype.setTraceEnabled, () => {
    it('applies the trace setting to conversations created afterwards', () => {
      const service = new GlyphService(new FakeBackend(), logger());

      service.setTraceEnabled(false);

      expect(service.isTraceEnabled).toBe(false);
      expect(service.createConversation(account, { slug: 'model-a', name: 'Model A' }).isTraceEnabled).toBe(false);
    });
  });

  describe(GlyphService.prototype.resolveChatRequest, () => {
    it('returns a text-only request when nothing is attached', async () => {
      const service = new GlyphService(new FakeBackend(), logger());

      await expect(service.resolveChatRequest('hello')).resolves.toEqual({ text: 'hello', attachments: [] });
    });

    it('rejects attachments when the host cannot resolve workspace context', async () => {
      const service = new GlyphService(new FakeBackend(), logger());

      await expect(service.resolveChatRequest('hello', [{ path: 'a.ts' }])).rejects.toThrow(
        'This host does not support workspace context attachments.',
      );
    });

    it('resolves attachments into fresh workspace snapshots', async () => {
      const attachments = [{ path: 'a.ts', content: 'export {}' }];
      const contextAttachments = { resolve: vi.fn(async () => attachments) };
      const service = new GlyphService(
        new FakeBackend(),
        logger(),
        {},
        undefined,
        contextAttachments as unknown as ContextAttachmentService,
      );

      await expect(service.resolveChatRequest('hello', [{ path: 'a.ts' }])).resolves.toEqual({
        text: 'hello',
        attachments,
      });
      expect(contextAttachments.resolve).toHaveBeenCalledWith([{ path: 'a.ts' }]);
    });
  });

  describe('persistent chat delegation', () => {
    it('refuses chat operations when the host has no chat storage', () => {
      const service = new GlyphService(new FakeBackend(), logger());

      expect(() => service.listChats(account)).toThrow('This host does not support persistent chat sessions.');
    });

    it('opens a stored chat with a conversation restored from its provider state', () => {
      const backend = new FakeBackend();
      const providerState = { provider: 'fake', version: 1, data: 'saved' };
      const record = { ...chatSummary('chat'), accountId: account.id, providerState };
      const sessions = {
        open: vi.fn(
          (
            _identifier: string,
            create: (value: typeof record) => unknown,
            assertCanOpen: (value: typeof record) => void,
          ) => {
            assertCanOpen(record);
            return create(record);
          },
        ),
      };
      const service = new GlyphService(
        backend,
        logger(),
        {},
        undefined,
        undefined,
        undefined,
        sessions as unknown as ChatSessionManager,
      );

      const opened = service.openChat('chat', account);

      expect(opened).toBeDefined();
      expect(sessions.open).toHaveBeenCalledWith('chat', expect.any(Function), expect.any(Function));
      expect(backend.createProvider).toHaveBeenCalledWith(account, { slug: 'model', name: 'Model' }, providerState);
    });

    it('branches a chat into a new conversation restored from the fork state', async () => {
      const backend = new FakeBackend();
      const providerState = { provider: 'fake', version: 1, data: 'fork' };
      const record = { ...chatSummary('chat'), accountId: account.id, providerState };
      const source = { id: 'chat' };
      const branched = { id: 'branch' };
      const sessions = {
        open: vi.fn(() => source),
        branch: vi.fn(async (_session: unknown, _turnId: string, create: (value: typeof record) => unknown) => {
          create(record);
          return branched;
        }),
      };
      const service = new GlyphService(
        backend,
        logger(),
        {},
        undefined,
        undefined,
        undefined,
        sessions as unknown as ChatSessionManager,
      );

      await expect(service.branchChat('chat', 'turn', account)).resolves.toBe(branched);
      expect(sessions.branch).toHaveBeenCalledWith(source, 'turn', expect.any(Function));
      expect(backend.createProvider).toHaveBeenCalledWith(account, { slug: 'model', name: 'Model' }, providerState);
    });
  });

  describe(GlyphService.prototype.commitReviewResults, () => {
    it('completes immediately when the host has no proposal reviews', async () => {
      const service = new GlyphService(new FakeBackend(), logger());
      const destination = { id: 'chat', recordContext: vi.fn() };

      await expect(service.commitReviewResults(destination)).resolves.toBeUndefined();
      expect(destination.recordContext).not.toHaveBeenCalled();
    });

    it('requires a chat id for chat-scoped delivery', async () => {
      const service = new GlyphService(new FakeBackend(), logger());

      await expect(service.commitReviewResults({ recordContext: vi.fn() }, { currentChatOnly: true })).rejects.toThrow(
        'Chat-scoped review delivery requires a chat id.',
      );
    });

    it('delivers only the current chat receipts during chat-scoped delivery', async () => {
      const own = reviewResult('own', { chatId: 'chat', accountProvider: 'fixture', accountId: 'account-1' });
      const foreign = reviewResult('foreign', { chatId: 'other', accountProvider: 'fixture', accountId: 'account-1' });
      const reviews = {
        pendingResults: [own, foreign],
        flushPendingCheckpoint: vi.fn(async () => {}),
        acknowledgeResults: vi.fn(async () => {}),
      };
      const service = new GlyphService(new FakeBackend(), logger(), {}, reviews as unknown as ProposalReviewManager);
      const destination = { id: 'chat', recordContext: vi.fn() };

      await service.commitReviewResults(destination, { currentChatOnly: true });

      expect(destination.recordContext).toHaveBeenCalledWith([
        { schemaVersion: 1, id: 'own', type: 'edit_review_result', payload: own },
      ]);
      expect(reviews.acknowledgeResults).toHaveBeenCalledWith(['own']);
    });

    it('delivers ownerless receipts to the requesting conversation', async () => {
      const legacy = reviewResult('legacy');
      const reviews = {
        pendingResults: [legacy],
        flushPendingCheckpoint: vi.fn(async () => {}),
        acknowledgeResults: vi.fn(async () => {}),
      };
      const service = new GlyphService(new FakeBackend(), logger(), {}, reviews as unknown as ProposalReviewManager);
      const destination = { recordContext: vi.fn() };

      await service.commitReviewResults(destination, { signal: new AbortController().signal });

      expect(destination.recordContext).toHaveBeenCalledWith([
        { schemaVersion: 1, id: 'legacy', type: 'edit_review_result', payload: legacy },
      ]);
      expect(reviews.acknowledgeResults).toHaveBeenCalledWith(['legacy']);
    });

    it('fails when the account that owns a receipt is no longer available', async () => {
      const result = reviewResult('receipt', { chatId: 'other', accountProvider: 'fixture', accountId: 'gone' });
      const reviews = {
        pendingResults: [result],
        flushPendingCheckpoint: vi.fn(async () => {}),
        acknowledgeResults: vi.fn(async () => {}),
      };
      const service = new GlyphService(new FakeBackend(), logger(), {}, reviews as unknown as ProposalReviewManager);

      await expect(service.commitReviewResults({ id: 'chat', recordContext: vi.fn() })).rejects.toThrow(
        'The proposal owner account is no longer available.',
      );
      expect(reviews.acknowledgeResults).not.toHaveBeenCalled();
    });

    it('rejects with the abort reason when cancelled before the delivery starts waiting', async () => {
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const reviews = {
        pendingResults: [],
        flushPendingCheckpoint: vi.fn(async () => {
          controller.abort(reason);
        }),
        acknowledgeResults: vi.fn(async () => {}),
      };
      const service = new GlyphService(new FakeBackend(), logger(), {}, reviews as unknown as ProposalReviewManager);

      await expect(
        service.commitReviewResults({ id: 'chat', recordContext: vi.fn() }, { signal: controller.signal }),
      ).rejects.toBe(reason);
    });

    it('surfaces a delivery failure to a caller that is still waiting', async () => {
      const failure = new Error('checkpoint failed');
      const reviews = {
        pendingResults: [],
        flushPendingCheckpoint: vi.fn(async () => {
          throw failure;
        }),
        acknowledgeResults: vi.fn(async () => {}),
      };
      const service = new GlyphService(new FakeBackend(), logger(), {}, reviews as unknown as ProposalReviewManager);

      await expect(
        service.commitReviewResults({ id: 'chat', recordContext: vi.fn() }, { signal: new AbortController().signal }),
      ).rejects.toBe(failure);
    });
  });
});

function chatSummary(id: string): ChatSessionSummary {
  return {
    schemaVersion: 3,
    id,
    title: 'Chat',
    titleOrigin: 'generated',
    projectContextId: 'project',
    accountProvider: 'fixture',
    accountId: 'account',
    modelSlug: 'model',
    modelName: 'Model',
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    turnCount: 0,
  };
}

function reviewResult(id: string, origin?: EditReviewResult['origin']): EditReviewResult {
  return {
    schemaVersion: 1,
    id,
    reviewId: 'proposal',
    ...(origin ? { origin } : {}),
    items: [
      {
        itemId: 'item',
        fileId: 'file',
        kind: EditReviewItemKind.TEXT,
        decision: EditDecisionState.ACCEPTED,
        affectedPaths: ['src/App.tsx'],
        resultingRevision: 'revision-2',
      },
    ],
  };
}

class MemoryChatSessionStore implements ChatSessionStore {
  private records: readonly ChatSessionRecord[] = [];

  async initialize(_context: ProjectContext): Promise<void> {}

  async load(projectContextId: string): Promise<readonly ChatSessionRecord[]> {
    return structuredClone(this.records.filter(record => record.projectContextId === projectContextId));
  }

  async save(record: ChatSessionRecord): Promise<void> {
    this.records = [...this.records.filter(candidate => candidate.id !== record.id), structuredClone(record)];
  }

  async dispose(): Promise<void> {}
}
