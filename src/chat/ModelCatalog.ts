import type { Model } from './Model.ts';

/** Provider-internal model discovery port parameterized by its credential representation. */
export interface ModelCatalog<TCredential> {
  list(credential: TCredential): Promise<Model[]>;
}
