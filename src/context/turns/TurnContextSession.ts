import {
  AgentInstructionActivationMode,
  AgentInstructionActivationReason,
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
  type AgentInstructionActivation,
  type AgentInstructionCandidate,
  type AgentInstructionContext,
  type AgentInstructionSource,
  type AgentInstructionTurnSnapshot,
} from '#src/instructions/AgentInstructionSource.js';
import { matchesAgentRulePath } from '#src/instructions/rules/matchesAgentRulePath.js';

/** Immutable inputs used to create one frozen logical-turn context. */
export interface TurnContextSessionInput {
  readonly turnId: string;
  readonly sources: readonly AgentInstructionSource[];
  readonly attachmentPaths: readonly string[];
  readonly manualRuleIds: readonly string[];
}

/** Owns context activation and disclosure state for one logical agent turn. */
export class TurnContextSession {
  private readonly activated = new Map<string, AgentInstructionActivation>();
  private readonly disclosed = new Set<string>();
  private readonly candidateSources: readonly AgentInstructionSource[];
  private readonly advertisedCandidates = new Map<string, AgentInstructionCandidate>();
  private readonly initial: AgentInstructionContext;

  constructor(private readonly input: TurnContextSessionInput) {
    this.candidateSources = input.sources.filter(
      source =>
        source.status === AgentInstructionSourceStatus.ACTIVE &&
        source.enabled !== false &&
        source.activation === AgentInstructionActivationMode.MODEL &&
        source.description !== undefined &&
        source.description !== '',
    );

    const attachments = unique(input.attachmentPaths);
    const candidates = this.advertiseCandidates(attachments);
    for (const source of input.sources) {
      if (!eligible(source)) continue;
      if (source.kind === AgentInstructionSourceKind.AGENTS_MD) {
        if (source.scope === '.') this.activate(source, AgentInstructionActivationReason.ALWAYS);
        else {
          const paths = attachments.filter(path => contains(source.scope, path));
          if (paths.length > 0) this.activate(source, AgentInstructionActivationReason.ATTACHMENT, paths);
        }
        continue;
      }
      if (source.activation === AgentInstructionActivationMode.ALWAYS && scopeParticipates(source.scope, attachments))
        this.activate(source, AgentInstructionActivationReason.ALWAYS);
      if (source.activation === AgentInstructionActivationMode.FILE_PATTERN) {
        const paths = attachments.filter(path => matchesAgentRulePath(source, path));
        if (paths.length > 0) this.activate(source, AgentInstructionActivationReason.ATTACHMENT, paths);
      }
    }
    for (const id of unique(input.manualRuleIds)) this.activateById(id, AgentInstructionActivationReason.MANUAL);
    this.initial = this.undisclosedContext(candidates) ?? emptyContext();
  }

  /** Initial instructions and bounded model-selectable metadata for provider turn creation. */
  initialEnvelope(): AgentInstructionContext {
    return structuredClone(this.initial);
  }

  /** Activate and disclose sources made applicable by project paths. */
  disclosePaths(paths: readonly string[]): AgentInstructionContext | undefined {
    return this.discloseMatchingPaths(paths, AgentInstructionActivationReason.FILE_ACCESS);
  }

  /** Activate and disclose rules made applicable by later user attachments or steering. */
  discloseAttachments(paths: readonly string[]): AgentInstructionContext | undefined {
    return this.discloseMatchingPaths(paths, AgentInstructionActivationReason.ATTACHMENT);
  }

  /** Explicitly activate manual rules selected after the turn begins. */
  activateManualRules(ruleIds: readonly string[]): AgentInstructionContext | undefined {
    for (const id of unique(ruleIds)) this.activateById(id, AgentInstructionActivationReason.MANUAL);
    return this.undisclosedContext([]);
  }

  /** Explicitly activate one eligible manual or model-selected rule. */
  activateRule(
    ruleId: string,
    reason: AgentInstructionActivationReason.MANUAL | AgentInstructionActivationReason.MODEL,
  ): AgentInstructionContext | undefined {
    this.activateById(ruleId, reason);
    return this.undisclosedContext([]);
  }

  /** Exact context provenance retained after the turn completes or compacts. */
  snapshot(): AgentInstructionTurnSnapshot {
    const activations = [...this.activated.values()];
    const ids = new Set(activations.map(activation => activation.sourceId));
    return {
      schema: 'glyph.turn-context.v1',
      turnId: this.input.turnId,
      sources: this.input.sources.filter(source => ids.has(source.id)),
      activations,
      candidates: [...this.advertisedCandidates.values()],
    };
  }

  private discloseMatchingPaths(
    paths: readonly string[],
    reason: AgentInstructionActivationReason.ATTACHMENT | AgentInstructionActivationReason.FILE_ACCESS,
  ): AgentInstructionContext | undefined {
    const normalized = unique(paths);
    const candidates = this.advertiseCandidates(normalized);
    for (const source of this.input.sources) {
      if (!eligible(source) || this.activated.has(source.id)) continue;
      const matching = normalized.filter(path =>
        source.kind === AgentInstructionSourceKind.AGENTS_MD
          ? contains(source.scope, path)
          : source.activation === AgentInstructionActivationMode.FILE_PATTERN && matchesAgentRulePath(source, path),
      );
      if (matching.length > 0) this.activate(source, reason, matching);
    }
    return this.undisclosedContext(candidates);
  }

  private activateById(
    id: string,
    reason: AgentInstructionActivationReason.MANUAL | AgentInstructionActivationReason.MODEL,
  ): void {
    const source = this.input.sources.find(candidate => candidate.id === id);
    if (!source || !eligible(source)) return;
    if (
      (reason === AgentInstructionActivationReason.MANUAL &&
        source.activation !== AgentInstructionActivationMode.MANUAL) ||
      (reason === AgentInstructionActivationReason.MODEL &&
        (source.activation !== AgentInstructionActivationMode.MODEL || !this.advertisedCandidates.has(source.id)))
    )
      return;
    this.activate(source, reason);
  }

  private activate(
    source: AgentInstructionSource,
    reason: AgentInstructionActivationReason,
    paths?: readonly string[],
  ) {
    if (this.activated.has(source.id)) return;
    this.activated.set(source.id, { sourceId: source.id, reason, ...(paths ? { paths } : {}) });
  }

  private advertiseCandidates(paths: readonly string[]): readonly AgentInstructionCandidate[] {
    const candidates = this.candidateSources
      .filter(source => !this.advertisedCandidates.has(source.id) && scopeParticipates(source.scope, paths))
      .map(source => ({
        id: source.id,
        name: source.name ?? source.label,
        description: source.description!,
        scope: source.scope,
      }));
    for (const candidate of candidates) this.advertisedCandidates.set(candidate.id, candidate);
    return candidates;
  }

  private undisclosedContext(candidates: readonly AgentInstructionCandidate[]): AgentInstructionContext | undefined {
    const sources = this.input.sources.filter(
      source => this.activated.has(source.id) && !this.disclosed.has(source.id),
    );
    for (const source of sources) this.disclosed.add(source.id);
    if (sources.length === 0 && candidates.length === 0) return undefined;
    return {
      schema: 'glyph.agent-instructions.v1',
      sources,
      activations: sources.map(source => this.activated.get(source.id)!),
      ...(candidates.length > 0 ? { candidates } : {}),
    };
  }
}

function eligible(source: AgentInstructionSource): boolean {
  return source.status === AgentInstructionSourceStatus.ACTIVE && source.enabled !== false;
}

function contains(scope: string, path: string): boolean {
  return scope === '.' || path === scope || path.startsWith(`${scope}/`);
}

function scopeParticipates(scope: string, paths: readonly string[]): boolean {
  return scope === '.' || paths.some(path => contains(scope, path));
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function emptyContext(): AgentInstructionContext {
  return {
    schema: 'glyph.agent-instructions.v1',
    sources: [],
  };
}
