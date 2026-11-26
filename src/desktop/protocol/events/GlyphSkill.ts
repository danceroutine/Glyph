/** Plain skill metadata shared across the utility-host and renderer boundary. */
export interface GlyphSkill {
  readonly id: string;
  readonly origin: {
    readonly id: string;
    readonly label: string;
    readonly scope: 'user' | 'project';
    readonly compatibility: string;
  };
  readonly path: string;
  readonly directory: string;
  readonly scope: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly status: 'active' | 'error';
  readonly revision?: string;
  readonly compatibility?: string;
  readonly installedFrom?: string;
  readonly packageRevision?: string;
  readonly allowedTools: readonly string[];
  readonly uri: string;
  readonly message?: string;
}

/** Retained activation evidence. This records context use, not completion of the skill's workflow. */
export interface GlyphSkillActivation {
  readonly descriptor: GlyphSkill;
  readonly revision: string;
  readonly reason: 'manual' | 'model';
  readonly explanation: string;
  readonly body: string;
  readonly resources: readonly {
    readonly path: string;
    readonly revision: string;
    readonly content: string;
    readonly encoding: 'utf8' | 'base64';
  }[];
}
