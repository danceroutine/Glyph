import type { SkillDescriptor, SkillOrigin } from './SkillDescriptor.ts';
import type { SkillPackage } from './SkillPackage.ts';

/** Location/compatibility extension point. Claude locations can be registered without changing catalog or activation. */
export interface SkillDiscoveryProvider {
  readonly id: string;
  readonly origin: SkillOrigin;
  /** A comparison key for qualified turn paths, preserving the workspace root's routing identity. */
  scopePathKey?(path: string): string;
  matchesLegacyId?(directory: string, id: string, budget: { remaining: number }): boolean;
  discover(signal?: AbortSignal): Promise<readonly SkillDescriptor[]>;
  /** Reconcile a concurrent publisher between the initial capture and its final verification. */
  capture(descriptor: SkillDescriptor, signal?: AbortSignal, reconcile?: () => Promise<void>): Promise<SkillPackage>;
  refreshIndex(): Promise<void>;
}
