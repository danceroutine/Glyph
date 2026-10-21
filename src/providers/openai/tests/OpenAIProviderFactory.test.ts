import OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigurationProvider } from '#src/configuration/ConfigurationProvider.js';
import { OpenAIProvider } from '#src/providers/openai/OpenAIProvider.js';
import { OpenAIProviderFactory } from '#src/providers/openai/OpenAIProviderFactory.js';
import { ToolRegistry } from '#src/tools/ToolRegistry.js';

function completedStream(): Response {
  const event = {
    type: 'response.completed',
    response: {
      id: 'resp_factory',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_factory',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello', annotations: [] }],
        },
      ],
      usage: null,
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

function configurationProvider(): ConfigurationProvider {
  return { chat: { instructions: '  Be concise.  ', timeoutMs: 60_000 } } as unknown as ConfigurationProvider;
}

describe(OpenAIProviderFactory, () => {
  describe(OpenAIProviderFactory.prototype.create, () => {
    it('creates a provider with project instructions, the supplied tools, and the injected client', async () => {
      const requests: Record<string, unknown>[] = [];
      const client = new OpenAI({
        apiKey: 'unused',
        maxRetries: 0,
        fetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return completedStream();
        },
      });
      const token = vi.fn(async () => 'oauth-token');
      const factory = new OpenAIProviderFactory('/unused-root', configurationProvider(), new ToolRegistry([]), client);

      const provider = factory.create('model-a', token);
      await provider.send('hello', { signal: new AbortController().signal, onText: () => {} });

      expect(provider).toBeInstanceOf(OpenAIProvider);
      expect(provider.model).toBe('model-a');
      expect(token).toHaveBeenCalledOnce();
      expect(requests[0]).toMatchObject({ model: 'model-a', tools: [] });
      expect(String(requests[0]?.instructions)).toMatch(/^# Identity\n\nBe concise\.\n\n# Instructions/);
    });

    it('defaults to project tools for its root and restores saved state', () => {
      const factory = new OpenAIProviderFactory(process.cwd(), configurationProvider());
      const state = {
        provider: 'openai-responses',
        version: 1,
        data: { history: [{ role: 'user', content: 'earlier' }] },
      };

      const provider = factory.create('model-b', async () => 'oauth-token', state);

      expect(provider.exportState()).toEqual(state);
    });
  });
});
