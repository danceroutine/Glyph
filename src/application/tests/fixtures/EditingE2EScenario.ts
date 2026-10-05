import type { EditingE2ERequirement } from './EditingE2ERequirement.ts';
import type { EditingE2EActorAction } from './EditingE2EActorAction.ts';

export interface EditingE2EScenario {
  readonly name: string;
  readonly covers: readonly EditingE2ERequirement[];
  readonly actors: readonly EditingE2EActorAction[];
}
