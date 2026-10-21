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

    it('reports unsuccessful discovery responses', async () => {
      const catalog = new OpenAIModelCatalog(configuration, {
        get: vi.fn(async () => ({ ok: false, status: 403, headers: new Headers(), body: {} })),
        post: vi.fn(),
      });

      await expect(catalog.list('oauth-token')).rejects.toThrow(
        'Model discovery returned HTTP 403. Check ChatGPT plan permissions or try again later. No API-key fallback is available.',
      );
    });

    it('rejects catalogs without a model list', async () => {
      const catalog = new OpenAIModelCatalog(configuration, {
        get: vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: { data: [] } })),
        post: vi.fn(),
      });

      await expect(catalog.list('oauth-token')).rejects.toThrow(
        'Unexpected subscription model catalog. Expected models[].',
      );
    });

    it('rejects catalogs without selectable models', async () => {
      const catalog = new OpenAIModelCatalog(configuration, {
        get: vi.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: {
            models: [
              { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
              { slug: 7, display_name: 'Numeric', visibility: 'list' },
              { slug: 'unnamed', visibility: 'list' },
            ],
          },
        })),
        post: vi.fn(),
      });

      await expect(catalog.list('oauth-token')).rejects.toThrow(
        'No selectable models are available to this ChatGPT account.',
      );
    });
  });
});
