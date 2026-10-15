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
    it('does not start an HTTP request after its discovery signal was already cancelled', async () => {
      const get = vi.fn<HttpClient['get']>();
      const catalog = new OpenAIModelCatalog(configuration, { get, post: vi.fn() });
      const cancellation = new AbortController();
      cancellation.abort(new Error('Discovery cancelled.'));
      await expect(catalog.list('oauth-token', cancellation.signal)).rejects.toThrow('Discovery cancelled.');
      expect(get).not.toHaveBeenCalled();
    });

    it('does not publish a catalog response that completes after cancellation', async () => {
      let release!: () => void;
      const get = vi.fn<HttpClient['get']>(
        () =>
          new Promise(resolve => {
            release = () =>
              resolve({
                ok: true,
                status: 200,
                headers: new Headers(),
                body: {
                  models: [{ slug: 'late', display_name: 'Late', visibility: 'list' }],
                },
              });
          }),
      );
      const catalog = new OpenAIModelCatalog(configuration, { get, post: vi.fn() });
      const cancellation = new AbortController();
      const pending = catalog.list('oauth-token', cancellation.signal);
      cancellation.abort(new Error('Discovery cancelled.'));
      release();
      await expect(pending).rejects.toThrow('Discovery cancelled.');
      expect(get.mock.calls[0]?.[1]?.signal).toBe(cancellation.signal);
    });

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
