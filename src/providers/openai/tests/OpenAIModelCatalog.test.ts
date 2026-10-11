import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '#src/http/HttpClient.js';
import type { OpenAIConfiguration } from '#src/providers/openai/OpenAIConfiguration.js';
import { OpenAIModelCatalog } from '#src/providers/openai/OpenAIModelCatalog.js';

const configuration: OpenAIConfiguration = {
  issuer: 'https://auth.example.test',
  resource: 'https://api.example.test/v1',
  scopes: 'openid plan',
  planScope: 'plan',
  requestTimeoutMs: 30_000,
};

describe(OpenAIModelCatalog, () => {
  describe(OpenAIModelCatalog.prototype.list, () => {
    it('uses an OAuth token and preserves visible model ordering', async () => {
      const get = vi.fn<HttpClient['get']>(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          models: [
            { slug: 'a', display_name: 'A', visibility: 'list' },
            { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
            { slug: 'b', display_name: 'B', visibility: 'list' },
          ],
        },
      }));
      const http = { get, post: vi.fn<HttpClient['post']>() } satisfies HttpClient;
      const catalog = new OpenAIModelCatalog(configuration, http);

      expect((await catalog.list('oauth-token')).map(model => model.slug)).toEqual(['a', 'b']);
      expect(get).toHaveBeenCalledWith(
        `${configuration.resource}/models`,
        expect.objectContaining({
          headers: { Authorization: 'Bearer oauth-token' },
        }),
      );
    });
  });
});
