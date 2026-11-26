import type { SkillDescriptor, SkillOrigin } from './SkillDescriptor.ts';
import type { SkillPackage } from './SkillPackage.ts';

/** Location/compatibility extension point. Claude locations can be registered without changing catalog or activation. */
export interface SkillDiscoveryProvider {
  readonly id: string;
  readonly origin: SkillOrigin;
  /** A comparison key for qualified turn paths, preserving the workspace root's routing identity. */
  scopePathKey?(path: string): string;
  discover(signal?: AbortSignal): Promise<readonly SkillDescriptor[]>;
  capture(descriptor: SkillDescriptor, signal?: AbortSignal): Promise<SkillPackage>;
  refreshIndex(): Promise<void>;
}
