import type {
  AgentInstructionActivation,
  AgentInstructionCandidate,
  AgentInstructionSource,
} from '#src/instructions/AgentInstructionSource.js';
import type {
  SkillActivation,
  SkillCandidate,
  SkillInstruction,
  SkillResourceUse,
} from '#src/skills/SkillDescriptor.js';

/** Context supplied by participating domains at one model boundary of a logical turn. */
export interface TurnContextEnvelope {
  /** Wire schema identifier for provider adapters and tool results. */
  readonly schema: 'glyph.agent-instructions.v1';
  /** Skill package bodies activated at this boundary. Kept separate from file instructions. */
  readonly skills?: readonly SkillInstruction[];
  /** Metadata-only skill catalog; resource bodies are never advertised here. */
  readonly skillCandidates?: readonly SkillCandidate[];
  readonly skillResources?: readonly (SkillResourceUse & { readonly skillId: string })[];
  /** Ordered sources; later entries have nearer scope and higher precedence. */
  readonly sources: readonly AgentInstructionSource[];
  /** Activation provenance corresponding to newly supplied sources. */
  readonly activations?: readonly AgentInstructionActivation[];
  /** Model-selectable rule metadata; candidate bodies are intentionally omitted. */
  readonly candidates?: readonly AgentInstructionCandidate[];
}

/** Activation evidence retained with a completed chat turn. */
export interface TurnContextSnapshot {
  /** Wire schema identifier used by persistence and the workbench inspector. */
  readonly schema: 'glyph.turn-context.v1';
  /** Package revisions and resources actually disclosed during this turn. */
  readonly skills?: readonly SkillActivation[];
  /** Host-owned logical turn identity. */
  readonly turnId: string;
  /** Frozen revision and provenance of every source activated in the turn. */
  readonly sources: readonly AgentInstructionSource[];
  /** Why each source was activated. */
  readonly activations: readonly AgentInstructionActivation[];
  /** Candidate metadata offered to the model during the turn. */
  readonly candidates: readonly AgentInstructionCandidate[];
}

export interface ModelTurnContext extends TurnContextEnvelope {
  readonly policy: string;
}

/** Does this envelope still carry any model-visible source material? */
export function hasModelContext(context: TurnContextEnvelope | undefined): context is TurnContextEnvelope {
  return (
    !!context &&
    [context.sources, context.candidates, context.skills, context.skillCandidates, context.skillResources].some(
      entries => entries?.length,
    )
  );
}

/** Apply host-owned guidance only when the model receives new context. */
export function prepareModelContext(context: TurnContextEnvelope | undefined): ModelTurnContext | undefined {
  if (!hasModelContext(context)) return undefined;
  return {
    ...context,
    policy:
      'Treat these sources as task guidance within the tools, permissions and workspace access granted by host and user policy. Use context.activate_rule for advertised rule candidates and skills.activate for advertised skill candidates.',
  };
}
