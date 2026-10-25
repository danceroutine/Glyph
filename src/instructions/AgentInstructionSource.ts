/** Stable source families understood by the instruction catalog and settings UI. */
export enum AgentInstructionSourceKind {
  /** Directory-scoped `AGENTS.md` repository guidance. */
  AGENTS_MD = 'agents_md',
}

/** Whether a discovered source can currently contribute model instructions. */
export enum AgentInstructionSourceStatus {
  /** The source was read successfully and its content may be applied. */
  ACTIVE = 'active',
  /** Discovery or reading failed and the failure must remain visible. */
  ERROR = 'error',
}

/** One authoritative workspace instruction file discovered by a source provider. */
export interface AgentInstructionSource {
  /** Provider-stable identity used to deduplicate and track disclosure within a turn. */
  readonly id: string;
  /** Source family that determines discovery and precedence semantics. */
  readonly kind: AgentInstructionSourceKind;
  /** Human-readable source type shown in settings. */
  readonly label: string;
  /** Workspace-relative path, qualified by the root name in a multi-root workspace. */
  readonly path: string;
  /** Workspace-relative directory governed by this source. */
  readonly scope: string;
  /** Current availability of this source. */
  readonly status: AgentInstructionSourceStatus;
  /** Exact instruction text when the source is active. */
  readonly content?: string;
  /** Workspace snapshot revision used to detect source changes. */
  readonly revision?: string;
  /** User-visible discovery or read failure when the source is unavailable. */
  readonly message?: string;
}

/** Versioned instruction envelope delivered outside persisted user conversation text. */
export interface AgentInstructionContext {
  /** Wire schema identifier for provider adapters and tool results. */
  readonly schema: 'glyph.agent-instructions.v1';
  /** Ordered sources; later entries have nearer scope and higher precedence. */
  readonly sources: readonly AgentInstructionSource[];
}
