import type { Model } from './Model.ts';

/** Provider-neutral model discovery port used during account activation. */
export interface ModelCatalog {
  list(accessToken: string): Promise<Model[]>;
}
