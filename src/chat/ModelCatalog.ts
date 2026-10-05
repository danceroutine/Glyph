import type { Model } from './Model.ts';

export interface ModelCatalog {
  list(accessToken: string): Promise<Model[]>;
}
