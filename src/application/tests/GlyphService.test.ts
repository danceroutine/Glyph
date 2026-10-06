import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider } from '../../chat/ChatProvider.ts';
import { toChatRequest } from '../../chat/ChatRequest.ts';
import type { ChatProviderFactory } from '../../chat/ChatProviderFactory.ts';
import type { WorkspaceFileSearch } from '../../context/search/WorkspaceFileSearch.ts';
import type { ChatResponsePart } from '../../chat/ChatResponsePart.ts';
import { ChatResponsePartType } from '../../chat/ChatResponsePartType.ts';
import type { ModelCatalog } from '../../chat/ModelCatalog.ts';
import { ToolActivityPhase } from '../../chat/ToolActivityPhase.ts';
import type { TurnResult } from '../../chat/TurnResult.ts';
import type { Logger } from '../../observability/Logger.ts';
import type { OpenAIConfiguration } from '../../providers/openai/OpenAIConfiguration.ts';
import type { OpenAIAccount } from '../../providers/openai/auth/OpenAIAccount.ts';
import type { OpenAIAccountStore } from '../../providers/openai/auth/OpenAIAccountStore.ts';
import type { OpenAISavedState } from '../../providers/openai/auth/OpenAISavedState.ts';
import type { OpenAISessionService } from '../../providers/openai/auth/OpenAISessionService.ts';
import { GlyphService } from '../GlyphService.ts';

const configuration: OpenAIConfiguration = {
  issuer: 'https://auth.example.test',
  resource: 'https://api.example.test/v1',
  scopes: 'openid plan',
  planScope: 'plan',
  requestTimeoutMs: 30_000,
};

const account: OpenAIAccount = {
  clientId: 'client',
  subject: 'subject',
  email: 'developer@example.com',
  tokens: {
    accessToken: 'access',
    refreshToken: 'refresh',
    idToken: 'id',
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: [configuration.planScope],
  },
};

class MemoryStore implements OpenAIAccountStore {
  readonly state: OpenAISavedState = { version: 1, hostId: 'urn:uuid:test', accounts: [account] };
  readonly acquire = vi.fn(async () => {});
  readonly load = vi.fn(async () => {});
  readonly save = vi.fn(async () => {});
  readonly release = vi.fn(async () => {});
}

class FakeSession implements OpenAISessionService {
  readonly signIn = vi.fn(async () => account);
  readonly accessToken = vi.fn(async () => 'access');
  readonly logout = vi.fn(async () => true);
  redact(message: string): string {
    return message.replaceAll('secret', '[REDACTED]');
  }
}

class FakeProvider implements ChatProvider {
  readonly model = 'model-a';
  readonly reset = vi.fn();
  readonly prompts: string[] = [];

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
      const store = new MemoryStore();
      const fileSearch: WorkspaceFileSearch = {
        initialize: vi.fn(async () => ({
          root: '/project',
          fileCount: 1,
          fromCache: false,
          truncated: false,
          durationMilliseconds: 1,
        })),
        search: vi.fn(),
        refresh: vi.fn(),
        dispose: vi.fn(async () => {}),
      };
      const service = new GlyphService(
        store,
        new FakeSession(),
        { list: async () => [] },
        { create: () => new FakeProvider() },
        logger(),
        configuration,
        {},
        undefined,
        undefined,
        fileSearch,
      );

      await service.initialize();
      await service.initialize();
      await service.dispose();
      await service.dispose();

      expect(fileSearch.initialize).toHaveBeenCalledOnce();
      expect(fileSearch.dispose).toHaveBeenCalledOnce();
      expect(store.acquire).toHaveBeenCalledOnce();
      expect(store.release).toHaveBeenCalledOnce();
    });

    it('disposes a failed file index and releases the account lock before surfacing startup failure', async () => {
      const store = new MemoryStore();
      const startupFailure = new Error('native index could not start');
      const fileSearch: WorkspaceFileSearch = {
        initialize: vi.fn(async () => {
          throw startupFailure;
        }),
        search: vi.fn(),
        refresh: vi.fn(),
        dispose: vi.fn(async () => {}),
      };
      const service = new GlyphService(
        store,
        new FakeSession(),
        { list: async () => [] },
        { create: () => new FakeProvider() },
        logger(),
        configuration,
        {},
        undefined,
        undefined,
        fileSearch,
      );

      await expect(service.initialize()).rejects.toBe(startupFailure);

      expect(fileSearch.dispose).toHaveBeenCalledOnce();
      expect(store.release).toHaveBeenCalledOnce();
      await service.dispose();
      expect(store.release).toHaveBeenCalledOnce();
    });
  });

  describe(GlyphService.prototype.createConversation, () => {
    it('exposes request-scoped response parts through injected lifecycle ports', async () => {
      const store = new MemoryStore();
      const session = new FakeSession();
      const provider = new FakeProvider();
      const catalog: ModelCatalog = { list: vi.fn(async () => [{ slug: 'model-a', name: 'Model A' }]) };
      const providers: ChatProviderFactory = { create: vi.fn(() => provider) };
      const traces: unknown[] = [];
      const service = new GlyphService(
        store,
        session,
        catalog,
        providers,
        logger(async (_message, data) => {
          traces.push(data);
        }),
        configuration,
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

      expect(store.acquire).toHaveBeenCalledOnce();
      expect(store.load).toHaveBeenCalledOnce();
      expect(store.release).toHaveBeenCalledOnce();
      expect(session.accessToken).toHaveBeenCalledOnce();
      expect(providers.create).toHaveBeenCalledWith('model-a', expect.any(Function));
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
        new MemoryStore(),
        new FakeSession(),
        { list: async () => [{ slug: 'model-a', name: 'Model A' }] },
        { create: () => new FakeProvider() },
        logger(async () => {
          throw new Error('secret disk failure');
        }),
        configuration,
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
      const service = new GlyphService(
        new MemoryStore(),
        new FakeSession(),
        { list: async () => [{ slug: 'model-a', name: 'Model A' }] },
        {
          create: () => {
            const provider = new FakeProvider();
            created.push(provider);
            return provider;
          },
        },
        logger(),
        configuration,
      );
      const first = service.createConversation(account, { slug: 'model-a', name: 'Model A' });
      const second = service.createConversation(account, { slug: 'model-a', name: 'Model A' });

      await first.send('first-session', { push: () => {} }, new AbortController().signal);
      await second.send('second-session', { push: () => {} }, new AbortController().signal);

      expect(created).toHaveLength(2);
      expect(created[0]?.prompts).toEqual(['first-session']);
      expect(created[1]?.prompts).toEqual(['second-session']);
    });
  });
});
