/** A discovery location supplied by a compatibility provider, independent of the package format. */
export interface SkillOrigin {
  readonly id: string;
  readonly label: string;
  readonly scope: 'user' | 'project';
  readonly compatibility: string;
}

/** Renderer-safe metadata. Discovery never publishes package bodies or resource contents. */
export interface SkillDescriptor {
  readonly id: string;
  readonly origin: SkillOrigin;
  readonly path: string;
  readonly directory: string;
  readonly scope: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly status: 'active' | 'error' | 'discovery-error';
  readonly revision?: string;
  readonly compatibility?: string;
  readonly allowedTools: readonly string[];
  readonly uri: string;
  readonly message?: string;
}

/** Exact resource contents disclosed to a model during a skill activation. */
export interface SkillResourceUse {
  readonly encoding: 'utf8' | 'base64';
  readonly path: string;
  readonly revision: string;
  readonly content: string;
}

/** Persistable activation provenance, distinct from discovery and workflow completion. */
export interface SkillActivation {
  readonly descriptor: SkillDescriptor;
  readonly revision: string;
  readonly reason: 'manual' | 'model';
  readonly explanation: string;
  readonly body: string;
  readonly resources: readonly SkillResourceUse[];
}

/** Model-visible metadata for choosing a package by its stable ID and scope. */
export interface SkillCandidate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scope: string;
  readonly origin: Pick<SkillOrigin, 'scope' | 'compatibility'>;
}

/** Activated model instructions. Storage and editor details stay in the local activation record. */
export interface SkillInstruction {
  readonly descriptor: SkillCandidate;
  readonly revision: string;
  readonly reason: SkillActivation['reason'];
  readonly explanation: string;
  readonly body: string;
  readonly compatibility?: string;
  readonly allowedTools?: readonly string[];
}
