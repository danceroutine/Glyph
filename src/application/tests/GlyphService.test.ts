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
});

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
