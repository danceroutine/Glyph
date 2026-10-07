import type { Model } from '../../../chat/Model.ts';
import type { ModelCatalog } from '../../../chat/ModelCatalog.ts';

export class FixtureModelCatalog implements ModelCatalog<string> {
  async list(): Promise<Model[]> {
    return [{ slug: 'test-model', name: 'Test Model' }];
  }
}
