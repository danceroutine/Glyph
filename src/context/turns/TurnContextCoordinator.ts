import type { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import { AgentInstructionActivationReason } from '#src/instructions/AgentInstructionSource.js';
import type {
  AgentInstructionContext,
  AgentInstructionTurnSnapshot,
} from '#src/instructions/AgentInstructionSource.js';
import { InstructionContextContributor } from './InstructionContextContributor.ts';
import type { TurnContextContribution, TurnContextContributor, TurnContextInput } from './TurnContextContributor.ts';

export type BeginTurnContextInput = TurnContextInput;

/** Compose independently prepared domains without mixing their discovery or activation rules. */
export class PreparedTurnContext {
  constructor(
    readonly turnId: string,
    readonly contributions: ReadonlyMap<string, TurnContextContribution>,
  ) {}
  initialEnvelope(): AgentInstructionContext {
    return mergeTurnContext([...this.contributions.values()].map(part => part.initialEnvelope()));
  }
  snapshot(): AgentInstructionTurnSnapshot {
    const parts = [...this.contributions.values()].map(part => part.snapshot());
    const skills = parts.flatMap(part => part.skills ?? []);
    return {
      schema: 'glyph.turn-context.v1',
      turnId: this.turnId,
      sources: parts.flatMap(part => part.sources),
      activations: parts.flatMap(part => part.activations),
      candidates: parts.flatMap(part => part.candidates),
      ...(skills.length > 0 ? { skills } : {}),
    };
  }
  release(): void {
    for (const part of this.contributions.values()) part.release?.();
  }
}

/** Coordinates provider-independent context preparation, disclosure, and lifecycle for a logical turn. */
export class TurnContextCoordinator {
  private readonly sessions = new Map<string, PreparedTurnContext>();
  private readonly pending = new Set<string>();
  private readonly contributors: readonly TurnContextContributor[];
  constructor(input: AgentInstructionCatalog | readonly TurnContextContributor[]) {
    this.contributors = 'refresh' in input ? [new InstructionContextContributor(input)] : input;
    if (new Set(this.contributors.map(part => part.id)).size !== this.contributors.length)
      throw new Error('Turn context contributor IDs must be unique.');
  }
  async beginTurn(input: BeginTurnContextInput, signal?: AbortSignal): Promise<PreparedTurnContext> {
    if (this.pending.has(input.turnId) || this.sessions.has(input.turnId)) throw new Error('This turn already has an active instruction session.');
    if (this.pending.size + this.sessions.size >= 32) throw new Error('32 turns are already active. Retry when one completes.');
    this.pending.add(input.turnId);
    const parts = new Map<string, TurnContextContribution>();
    try {
      for (const contributor of this.contributors) {
        signal?.throwIfAborted();
        parts.set(contributor.id, await contributor.beginTurn(input, signal));
        signal?.throwIfAborted();
      }
    } catch (error) {
      for (const part of parts.values()) part.release?.();
      throw error;
    } finally {
      this.pending.delete(input.turnId);
    }
    const session = new PreparedTurnContext(input.turnId, parts);
    this.sessions.set(input.turnId, session);
    return session;
  }
  disclosePaths(turnId: string, paths: readonly string[]): AgentInstructionContext | undefined {
    return this.disclose(turnId, part => part.disclosePaths?.(paths));
  }
  discloseAttachments(turnId: string, paths: readonly string[]): AgentInstructionContext | undefined {
    return this.disclose(turnId, part => part.discloseAttachments?.(paths));
  }
  activateManualRules(turnId: string, ids: readonly string[]): AgentInstructionContext | undefined {
    return this.disclose(turnId, part => part.activateManualRules?.(ids));
  }
  activateRule(turnId: string, id: string): AgentInstructionContext | undefined {
    return this.disclose(turnId, part => part.activateRule?.(id, AgentInstructionActivationReason.MODEL));
  }
  async activateSource(
    turnId: string,
    contributorId: string,
    sourceId: string,
    reason: 'manual' | 'model',
    explanation: string,
    signal?: AbortSignal,
  ): Promise<AgentInstructionContext | undefined> {
    return this.sessions
      .get(turnId)
      ?.contributions.get(contributorId)
      ?.activateSource?.(sourceId, reason, explanation, signal);
  }
  contribution(turnId: string, id: string): TurnContextContribution | undefined {
    return this.sessions.get(turnId)?.contributions.get(id);
  }
  snapshot(turnId: string): AgentInstructionTurnSnapshot | undefined {
    return this.sessions.get(turnId)?.snapshot();
  }
  completeTurn(turnId: string): AgentInstructionTurnSnapshot | undefined {
    const snapshot = this.snapshot(turnId);
    this.discardTurn(turnId);
    return snapshot;
  }
  discardTurn(turnId: string): void {
    this.sessions.get(turnId)?.release();
    this.sessions.delete(turnId);
  }
  private disclose(
    turnId: string,
    operation: (part: TurnContextContribution) => AgentInstructionContext | undefined,
  ): AgentInstructionContext | undefined {
    const parts = [...(this.sessions.get(turnId)?.contributions.values() ?? [])].flatMap(part => {
      const context = operation(part);
      return context ? [context] : [];
    });
    return parts.length > 0 ? mergeTurnContext(parts) : undefined;
  }
}

/** Preserve separate payloads for instruction and package domains in one versioned turn envelope. */
export function mergeTurnContext(parts: readonly AgentInstructionContext[]): AgentInstructionContext {
  const candidates = parts.flatMap(part => part.candidates ?? []);
  const activations = parts.flatMap(part => part.activations ?? []);
  const skills = parts.flatMap(part => part.skills ?? []);
  const skillCandidates = parts.flatMap(part => part.skillCandidates ?? []);
  return {
    schema: 'glyph.agent-instructions.v1',
    sources: parts.flatMap(part => part.sources),
    ...(candidates.length > 0 ? { candidates } : {}),
    ...(activations.length > 0 ? { activations } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(skillCandidates.length > 0 ? { skillCandidates } : {}),
  };
}
