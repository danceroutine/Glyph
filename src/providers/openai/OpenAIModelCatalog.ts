import { ProviderError } from '../../errors/ProviderError.ts';
import type { HttpClient } from '../../http/HttpClient.ts';
import { toRecord } from '../../shared/mappers/toRecord.ts';
import type { Model } from '../../chat/Model.ts';
import type { ModelCatalog } from '../../chat/ModelCatalog.ts';
import type { OpenAIConfiguration } from './OpenAIConfiguration.ts';

export class OpenAIModelCatalog implements ModelCatalog {
  constructor(
    private readonly configuration: OpenAIConfiguration,
    private readonly http: HttpClient,
  ) {}

  async list(accessToken: string): Promise<Model[]> {
    const response = await this.http.get(`${this.configuration.resource}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: 'error',
      timeoutMs: this.configuration.requestTimeoutMs,
    });
    if (!response.ok) {
      throw new ProviderError(`Model discovery returned HTTP ${response.status}. Check ChatGPT plan permissions or try again later. No API-key fallback is available.`);
    }
    const body = toRecord(response.body);
    if (!Array.isArray(body.models)) {
      throw new ProviderError('Unexpected subscription model catalog. Expected models[].');
    }
    const models = body.models
      .map(toRecord)
      .filter(model => model.visibility === 'list'
        && typeof model.slug === 'string'
        && typeof model.display_name === 'string')
      .map(model => ({ slug: String(model.slug), name: String(model.display_name) }));
    if (!models.length) throw new ProviderError('No selectable models are available to this ChatGPT account.');
    return models;
  }
}
