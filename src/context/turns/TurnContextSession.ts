import type { TurnContextEnvelope, TurnContextSnapshot } from './TurnContextEnvelope.ts';
import {
  AgentInstructionActivationMode,
  AgentInstructionActivationReason,
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
  type AgentInstructionActivation,
  type AgentInstructionCandidate,
  type AgentInstructionSource,
} from '#src/instructions/AgentInstructionSource.js';
import { resolveInstructionId } from '#src/instructions/resolveInstructionId.js';
import { AgentInstructionSet, isUnavailableGuidance } from '#src/instructions/AgentInstructionSet.js';
import { defaultInstructionPaths, type InstructionPaths } from '#src/instructions/InstructionPaths.js';
import { matchesAgentRulePath, RuleGlobBudget } from '#src/instructions/rules/matchesAgentRulePath.js';

/** Immutable inputs used to create one frozen logical-turn context. */
export interface TurnContextSessionInput {
  readonly turnId: string;
  readonly paths?: InstructionPaths;
  readonly scopeIndex?: AgentInstructionSet;
  readonly sources: readonly AgentInstructionSource[];
  readonly attachmentPaths: readonly string[];
  readonly manualRuleIds: readonly string[];
}

/** Owns context activation and disclosure state for one logical agent turn. */
export class TurnContextSession {
  private activated = new Map<string, AgentInstructionActivation>();
  private pending = new Map<AgentInstructionSource, AgentInstructionActivation>();
  private readonly scopeIndex: AgentInstructionSet;
  private readonly precedence: ReadonlyMap<AgentInstructionSource, number>;
  private advertisedCandidates = new Map<string, AgentInstructionCandidate>();
  private readonly initial: TurnContextEnvelope;

  private readonly paths: InstructionPaths;
  private remainingBytes = 512 * 1024;

  constructor(private readonly input: TurnContextSessionInput) {
    this.paths = input.paths ?? defaultInstructionPaths;
    this.scopeIndex = input.scopeIndex ?? new AgentInstructionSet(input.sources, this.paths);
    this.precedence = new Map(input.sources.map((source, index) => [source, index]));
    const unreadable = input.sources.find(
      source => isUnavailableGuidance(source) && this.paths.isWorkspaceRoot(source.scope),
    );
    if (unreadable)
      throw new Error(
        `Required root instruction ${unreadable.path} could not be loaded. ${unreadable.message ?? ''}`.trimEnd(),
      );
    const budget = new RuleGlobBudget();
    const attachments = unique(input.attachmentPaths);
    const applicable = this.sourcesFor(attachments, this.scopeIndex.rootGuidance);
    const candidates = this.advertiseCandidates(applicable);
    for (const source of applicable) {
      if (!eligible(source)) continue;
      if (source.kind === AgentInstructionSourceKind.AGENTS_MD) {
        if (this.paths.isWorkspaceRoot(source.scope)) this.activate(source, AgentInstructionActivationReason.ALWAYS);
        else {
          const paths = attachments.filter(path => this.paths.contains(source.scope, path));
          this.activate(source, AgentInstructionActivationReason.ATTACHMENT, paths);
        }
        continue;
      }
      if (source.activation === AgentInstructionActivationMode.ALWAYS)
        this.activate(source, AgentInstructionActivationReason.ALWAYS);
      if (source.activation === AgentInstructionActivationMode.FILE_PATTERN) {
        const paths = attachments.filter(path => matchesAgentRulePath(source, path, this.paths, budget));
        if (paths.length > 0) this.activate(source, AgentInstructionActivationReason.ATTACHMENT, paths);
      }
    }
    this.stageManualRules(input.manualRuleIds);
    this.initial = this.undisclosedContext(candidates) ?? emptyContext();
  }

  /** Initial instructions and bounded model-selectable metadata for provider turn creation. */
  checkpointSteering(): () => void {
    const activated = new Map(this.activated);
    const pending = new Map(this.pending);
    const advertised = new Map(this.advertisedCandidates);
    const remainingBytes = this.remainingBytes;
    return () => {
      this.activated = activated;
      this.pending = pending;
      this.advertisedCandidates = advertised;
      this.remainingBytes = remainingBytes;
    };
  }
  initialEnvelope(): TurnContextEnvelope {
    return structuredClone(this.initial);
  }

  /** Activate and disclose sources made applicable by project paths. */
  disclosePaths(paths: readonly string[]): TurnContextEnvelope | undefined {
    return this.discloseMatchingPaths(paths, AgentInstructionActivationReason.FILE_ACCESS);
  }

  /** Activate and disclose rules made applicable by later user attachments or steering. */
  discloseAttachments(paths: readonly string[]): TurnContextEnvelope | undefined {
    return this.discloseMatchingPaths(paths, AgentInstructionActivationReason.ATTACHMENT);
  }

  /** Explicitly activate manual rules selected after the turn begins. */
  activateManualRules(ruleIds: readonly string[]): TurnContextEnvelope | undefined {
    this.stageManualRules(ruleIds);
    return this.undisclosedContext([]);
  }

  /** Explicitly activate one eligible manual or model-selected rule. */
  activateRule(
    ruleId: string,
    reason: AgentInstructionActivationReason.MANUAL | AgentInstructionActivationReason.MODEL,
  ): TurnContextEnvelope | undefined {
    if (reason === AgentInstructionActivationReason.MANUAL) return this.activateManualRules([ruleId]);
    const source = resolveInstructionId(this.input.sources, ruleId);
    if (
      source &&
      eligible(source) &&
      source.activation === AgentInstructionActivationMode.MODEL &&
      this.advertisedCandidates.has(source.id)
    )
      this.activate(source, reason);
    return this.undisclosedContext([]);
  }

  /** Exact context provenance retained after the turn completes or compacts. */
  snapshot(): TurnContextSnapshot {
    const activations = [...this.activated.values()];
    const ids = new Set(activations.map(activation => activation.sourceId));
    return {
      schema: 'glyph.turn-context.v1',
      turnId: this.input.turnId,
      sources: this.input.sources
        .filter(source => ids.has(source.id))
        .map(({ legacyIds: _legacyIds, ...source }) => source),
      activations,
      candidates: [...this.advertisedCandidates.values()],
    };
  }

  private discloseMatchingPaths(
    paths: readonly string[],
    reason: AgentInstructionActivationReason.ATTACHMENT | AgentInstructionActivationReason.FILE_ACCESS,
  ): TurnContextEnvelope | undefined {
    const budget = new RuleGlobBudget();
    const normalized = unique(paths);
    const applicable = this.sourcesFor(normalized);
    const candidates = this.advertiseCandidates(applicable);
    const matched = new Map<AgentInstructionSource, readonly string[]>();
    for (const source of applicable) {
      if (!eligible(source) || this.activated.has(source.id)) continue;
      const matching = normalized.filter(path =>
        source.kind === AgentInstructionSourceKind.AGENTS_MD ||
        source.activation === AgentInstructionActivationMode.ALWAYS
          ? this.paths.contains(source.scope, path)
          : source.activation === AgentInstructionActivationMode.FILE_PATTERN &&
            matchesAgentRulePath(source, path, this.paths, budget),
      );
      if (matching.length > 0) matched.set(source, matching);
    }
    for (const [source, matching] of matched) this.activate(source, reason, matching);
    return this.undisclosedContext(candidates);
  }

  private stageManualRules(ids: readonly string[]): void {
    const selected: AgentInstructionSource[] = [];
    for (const id of unique(ids)) {
      const source = resolveInstructionId(this.input.sources, id);
      if (!source) throw new Error('Selected manual rule is unavailable. Remove it or choose another rule.');
      if (!eligible(source) || source.activation !== AgentInstructionActivationMode.MANUAL)
        throw new Error(
          `Selected rule ${source.path} is no longer available for manual activation. Remove it or choose another rule.`,
        );
      selected.push(source);
    }
    for (const source of selected) this.activate(source, AgentInstructionActivationReason.MANUAL);
  }

  private activate(
    source: AgentInstructionSource,
    reason: AgentInstructionActivationReason,
    paths?: readonly string[],
  ) {
    if (this.activated.has(source.id)) return;
    this.pending.set(source, { sourceId: source.id, reason, ...(paths ? { paths } : {}) });
  }

  private sourcesFor(
    paths: readonly string[],
    upfront: readonly AgentInstructionSource[] = [],
  ): readonly AgentInstructionSource[] {
    const applicable = new Set([...this.scopeIndex.forPath('.'), ...upfront]);
    for (const path of paths) {
      for (const source of this.scopeIndex.forPath(path, true)) {
        if (isUnavailableGuidance(source))
          throw new Error(`Required instruction ${source.path} could not be loaded. ${source.message ?? ''}`.trimEnd());
        applicable.add(source);
      }
    }
    return [...applicable].toSorted((a, b) => this.precedence.get(a)! - this.precedence.get(b)!);
  }

  private advertiseCandidates(sources: readonly AgentInstructionSource[]): readonly AgentInstructionCandidate[] {
    const candidates: AgentInstructionCandidate[] = [];
    for (const source of sources) {
      if (
        !eligible(source) ||
        source.activation !== AgentInstructionActivationMode.MODEL ||
        !source.description ||
        this.advertisedCandidates.has(source.id)
      )
        continue;
      const candidate = {
        id: source.id,
        name: source.name ?? source.label,
        description: source.description,
        scope: source.scope,
      };
      candidates.push(candidate);
    }
    return candidates;
  }

  private undisclosedContext(candidates: readonly AgentInstructionCandidate[]): TurnContextEnvelope | undefined {
    const pending = [...this.pending.entries()].toSorted(
      ([a], [b]) => this.precedence.get(a)! - this.precedence.get(b)!,
    );
    this.pending.clear();
    if (pending.length === 0 && candidates.length === 0) return undefined;
    const envelope: TurnContextEnvelope = {
      schema: 'glyph.agent-instructions.v1',
      sources: pending.map(([source]) => {
        const { uri: _editorUri, legacyIds: _legacyIds, ...instruction } = source;
        return instruction;
      }),
      activations: pending.map(([, activation]) => activation),
      ...(candidates.length > 0 ? { candidates } : {}),
    };
    // Measure one bounded source at a time. A large set of applicable rules can exceed the turn
    // allowance before the adapter ever serializes a combined envelope.
    let bytes = Buffer.byteLength(
      JSON.stringify({
        schema: envelope.schema,
        sources: [],
        activations: [],
        ...(candidates.length > 0 ? { candidates: [] } : {}),
      }),
    );
    for (const entries of [envelope.sources, envelope.activations!, candidates]) {
      for (const [index, entry] of entries.entries()) {
        bytes += Buffer.byteLength(JSON.stringify(entry)) + Number(index > 0);
        if (bytes > this.remainingBytes)
          throw new Error(
            'The instruction context exceeds the 512 KiB turn limit. Reduce the applicable instructions and retry.',
          );
      }
    }
    this.remainingBytes -= bytes;
    for (const [source, activation] of pending) this.activated.set(source.id, activation);
    for (const candidate of candidates) this.advertisedCandidates.set(candidate.id, candidate);
    return envelope;
  }
}

function eligible(source: AgentInstructionSource): boolean {
  return source.status === AgentInstructionSourceStatus.ACTIVE && source.enabled !== false;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function emptyContext(): TurnContextEnvelope {
  return {
    schema: 'glyph.agent-instructions.v1',
    sources: [],
  };
}
