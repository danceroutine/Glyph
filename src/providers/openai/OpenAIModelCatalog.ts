import { ProviderError } from '#src/errors/ProviderError.js';
import type { HttpClient } from '#src/http/HttpClient.js';
import { toRecord } from '#src/shared/mappers/toRecord.js';
import type { Model } from '#src/chat/Model.js';
import type { ModelCatalog } from '#src/chat/ModelCatalog.js';
import type { OpenAIConfiguration } from './OpenAIConfiguration.ts';

export class OpenAIModelCatalog implements ModelCatalog<string> {
  constructor(
    private readonly configuration: OpenAIConfiguration,
    private readonly http: HttpClient,
  ) {}

  async list(accessToken: string, signal?: AbortSignal): Promise<Model[]> {
    signal?.throwIfAborted();
    const response = await this.http.get(`${this.configuration.resource}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      timeoutMs: this.configuration.requestTimeoutMs,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    if (!response.ok) {
      throw new ProviderError(
        `Model discovery returned HTTP ${response.status}. Check ChatGPT plan permissions or try again later. No API-key fallback is available.`,
      );
    }
    const body = toRecord(response.body);
    if (!Array.isArray(body.models)) {
      throw new ProviderError('Unexpected subscription model catalog. Expected models[].');
    }
    const models = body.models
      .map(toRecord)
      .filter(
        model =>
          model.visibility === 'list' && typeof model.slug === 'string' && typeof model.display_name === 'string',
      )
      .map(model => ({ slug: String(model.slug), name: String(model.display_name) }));
    if (models.length === 0) throw new ProviderError('No selectable models are available to this ChatGPT account.');
    return models;
  }
}
