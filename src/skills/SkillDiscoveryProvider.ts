import type { SkillDescriptor } from './SkillDescriptor.ts';
import type { SkillPackage } from './SkillPackage.ts';

/** Location/compatibility extension point. Claude locations can be registered without changing catalog or activation. */
export interface SkillDiscoveryProvider {
  readonly id: string;
  discover(signal?: AbortSignal): Promise<readonly SkillDescriptor[]>;
  capture(descriptor: SkillDescriptor, signal?: AbortSignal): Promise<SkillPackage>;
  refreshIndex(): Promise<void>;
}
