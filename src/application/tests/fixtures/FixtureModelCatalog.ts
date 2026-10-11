import type { Model } from '#src/chat/Model.js';
import type { ModelCatalog } from '#src/chat/ModelCatalog.js';

export class FixtureModelCatalog implements ModelCatalog<string> {
  async list(): Promise<Model[]> {
    return [{ slug: 'test-model', name: 'Test Model' }];
  }
}
