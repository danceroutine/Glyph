import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider } from '../../chat/ChatProvider.ts';
import type { ChatProviderFactory } from '../../chat/ChatProviderFactory.ts';
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
import { HarnessService } from '../HarnessService.ts';

const configuration: OpenAIConfiguration = {
  issuer: 'https://auth.example.test',
  resource: 'https://api.example.test/v1',
  scopes: 'openid plan',
  planScope: 'plan',
  requestTimeoutMs: 30_000,
};

const account: OpenAIAccount = {
  clientId: 'client', subject: 'subject', email: 'developer@example.com',
  tokens: {
    accessToken: 'access', refreshToken: 'refresh', idToken: 'id',
    expiresAt: Number.MAX_SAFE_INTEGER, scopes: [configuration.planScope],
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
  redact(message: string): string { return message.replaceAll('secret', '[REDACTED]'); }
}

class FakeProvider implements ChatProvider {
  readonly model = 'model-a';
  readonly reset = vi.fn();
  readonly prompts: string[] = [];

  async send(text: string, options: Parameters<ChatProvider['send']>[1]): Promise<TurnResult> {
    this.prompts.push(text);
    options.onTrace?.({ sequence: 1, timestamp: 'now', kind: 'request', data: { text } });
    options.onToolActivity?.({
      phase: ToolActivityPhase.STARTED, namespace: 'project', name: 'read_project_file',
      callId: 'call', arguments: '{}',
    });
    options.onText('answer');
    return {
      responseId: 'response',
      usage: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2, reasoningTokens: 1, totalTokens: 5 },
    };
  }
}

function logger(trace: Logger['trace'] = async () => {}): Logger {
  return {
    destination: '/config/trace.log', trace,
    debug: async () => {}, info: async () => {}, warn: async () => {}, error: async () => {},
  };
}

describe(HarnessService, () => {
  describe(HarnessService.prototype.createConversation, () => {
    it('exposes request-scoped response parts through injected lifecycle ports', async () => {
      const store = new MemoryStore();
      const session = new FakeSession();
      const provider = new FakeProvider();
      const catalog: ModelCatalog = { list: vi.fn(async () => [{ slug: 'model-a', name: 'Model A' }]) };
      const providers: ChatProviderFactory = { create: vi.fn(() => provider) };
      const traces: unknown[] = [];
      const harness = new HarnessService(
        store, session, catalog, providers,
        logger(async (_message, data) => { traces.push(data); }), configuration,
      );
      const parts: ChatResponsePart[] = [];

      await harness.initialize();
      expect(await harness.listModels(account)).toEqual([{ slug: 'model-a', name: 'Model A' }]);
      const conversation = harness.createConversation(account, { slug: 'model-a', name: 'Model A' });
      const result = await conversation.send('question', { push: part => parts.push(part) }, new AbortController().signal);
      conversation.reset();
      await harness.dispose();

      expect(store.acquire).toHaveBeenCalledOnce();
      expect(store.load).toHaveBeenCalledOnce();
      expect(store.release).toHaveBeenCalledOnce();
      expect(session.accessToken).toHaveBeenCalledOnce();
      expect(providers.create).toHaveBeenCalledWith('model-a', expect.any(Function));
      expect(parts).toEqual([
        expect.objectContaining({ type: ChatResponsePartType.TOOL }),
        { type: ChatResponsePartType.TEXT, value: 'answer' },
      ]);
      expect(result.responseId).toBe('response');
      expect(harness.usage.totalTokens).toBe(5);
      expect(traces[0]).toEqual([expect.objectContaining({ kind: 'request' })]);
      expect(provider.reset).toHaveBeenCalledOnce();
    });

    it('reports logger failures without discarding a completed turn', async () => {
      const harness = new HarnessService(
        new MemoryStore(), new FakeSession(),
        { list: async () => [{ slug: 'model-a', name: 'Model A' }] },
        { create: () => new FakeProvider() },
        logger(async () => { throw new Error('secret disk failure'); }), configuration,
      );
      const conversation = harness.createConversation(account, { slug: 'model-a', name: 'Model A' });
      const parts: ChatResponsePart[] = [];

      const result = await conversation.send('question', { push: part => parts.push(part) }, new AbortController().signal);

      expect(result.responseId).toBe('response');
      expect(parts).toContainEqual(expect.objectContaining({
        type: ChatResponsePartType.DIAGNOSTIC,
        message: 'Trace log write failed: [REDACTED] disk failure',
      }));
    });

    it('creates isolated provider history for each host-owned conversation', async () => {
      const created: FakeProvider[] = [];
      const harness = new HarnessService(
        new MemoryStore(), new FakeSession(),
        { list: async () => [{ slug: 'model-a', name: 'Model A' }] },
        { create: () => { const provider = new FakeProvider(); created.push(provider); return provider; } },
        logger(), configuration,
      );
      const first = harness.createConversation(account, { slug: 'model-a', name: 'Model A' });
      const second = harness.createConversation(account, { slug: 'model-a', name: 'Model A' });

      await first.send('first-session', { push: () => {} }, new AbortController().signal);
      await second.send('second-session', { push: () => {} }, new AbortController().signal);

      expect(created).toHaveLength(2);
      expect(created[0]?.prompts).toEqual(['first-session']);
      expect(created[1]?.prompts).toEqual(['second-session']);
    });
  });
});
