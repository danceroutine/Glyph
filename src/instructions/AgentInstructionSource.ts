/** Stable source families understood by the instruction catalog and settings UI. */
export enum AgentInstructionSourceKind {
  /** Directory-scoped `AGENTS.md` repository guidance. */
  AGENTS_MD = 'agents_md',
  /** A native project rule discovered below `.glyph/rules`. */
  GLYPH_PROJECT_RULE = 'glyph_project_rule',
  /** A native user rule discovered below `~/.glyph/rules`. */
  GLYPH_USER_RULE = 'glyph_user_rule',
  /** A Cursor-compatible project rule discovered below `.cursor/rules`. */
  CURSOR_PROJECT_RULE = 'cursor_project_rule',
}

/** Determines when a rule contributes its full instruction body to a turn. */
export enum AgentInstructionActivationMode {
  /** Include the rule when its owning workspace root participates in a turn. */
  ALWAYS = 'always',
  /** Include the rule after an in-scope path matches one of its glob patterns. */
  FILE_PATTERN = 'file_pattern',
  /** Advertise bounded metadata and let the agent explicitly activate the rule. */
  MODEL = 'model',
  /** Include the rule only after the user explicitly selects it. */
  MANUAL = 'manual',
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
  /** Revision of the rule file itself, excluding referenced-file revisions. */
  readonly sourceRevision?: string;
  /** User-visible discovery or read failure when the source is unavailable. */
  readonly message?: string;
  /** Rule activation mode. Absent for sources such as `AGENTS.md`. */
  readonly activation?: AgentInstructionActivationMode;
  /** Human-facing rule name used by settings, selection, and provenance UI. */
  readonly name?: string;
  /** Bounded description exposed to the model for model-selected rules. */
  readonly description?: string;
  /** Project-relative file patterns used by file-pattern rules. */
  readonly globs?: readonly string[];
  /** Whether the rule is eligible for activation. Errors are always ineligible. */
  readonly enabled?: boolean;
  /** Source files incorporated into the instruction body, in deterministic order. */
  readonly references?: readonly string[];
  /** URI that can be opened directly when the source is outside the workspace. */
  readonly uri?: string;
}

/** Why an instruction source was included in a logical turn. */
export enum AgentInstructionActivationReason {
  /** Workspace-wide repository guidance or an enabled always-on rule. */
  ALWAYS = 'always',
  /** A user attachment matched the source scope or file patterns. */
  ATTACHMENT = 'attachment',
  /** A project tool accessed or proposed a matching path. */
  FILE_ACCESS = 'file_access',
  /** The user explicitly selected a manual rule. */
  MANUAL = 'manual',
  /** The model invoked the bounded rule-activation tool. */
  MODEL = 'model',
}

/** Persistable provenance for one source activated during a turn. */
export interface AgentInstructionActivation {
  /** Stable source identity from the frozen discovery snapshot. */
  readonly sourceId: string;
  /** Trigger that caused the source to become visible to the model. */
  readonly reason: AgentInstructionActivationReason;
  /** Paths that caused activation, when activation was path-derived. */
  readonly paths?: readonly string[];
}

/** Metadata advertised for a rule whose body has not yet been activated. */
export interface AgentInstructionCandidate {
  /** Stable source identity accepted by the rule-activation tool. */
  readonly id: string;
  /** Display name of the candidate rule. */
  readonly name: string;
  /** Bounded relevance description supplied by the rule author. */
  readonly description: string;
  /** Workspace scope in which the rule may be selected. */
  readonly scope: string;
}

/** Versioned instruction envelope delivered outside persisted user conversation text. */
export interface AgentInstructionContext {
  /** Wire schema identifier for provider adapters and tool results. */
  readonly schema: 'glyph.agent-instructions.v1';
  /** Ordered sources; later entries have nearer scope and higher precedence. */
  readonly sources: readonly AgentInstructionSource[];
  /** Activation provenance corresponding to newly supplied sources. */
  readonly activations?: readonly AgentInstructionActivation[];
  /** Model-selectable rule metadata; candidate bodies are intentionally omitted. */
  readonly candidates?: readonly AgentInstructionCandidate[];
}

/** Serializable context state retained with a completed chat turn. */
export interface AgentInstructionTurnSnapshot {
  /** Wire schema identifier used by persistence and the workbench inspector. */
  readonly schema: 'glyph.turn-context.v1';
  /** Host-owned logical turn identity. */
  readonly turnId: string;
  /** Frozen revision and provenance of every source activated in the turn. */
  readonly sources: readonly AgentInstructionSource[];
  /** Why each source was activated. */
  readonly activations: readonly AgentInstructionActivation[];
  /** Candidate metadata offered to the model during the turn. */
  readonly candidates: readonly AgentInstructionCandidate[];
}
