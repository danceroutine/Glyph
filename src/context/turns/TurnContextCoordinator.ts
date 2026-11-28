import { authorizeSources } from '#src/workspace/SourceDisclosure.js';
import { TurnDisclosure } from './TurnDisclosure.ts';
import { prepareModelContext, type TurnContextEnvelope, type TurnContextSnapshot } from './TurnContextEnvelope.ts';
import type { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import { AgentInstructionActivationReason } from '#src/instructions/AgentInstructionSource.js';
import { InstructionContextContributor } from './InstructionContextContributor.ts';
import type {
  TurnContextContribution,
  TurnContextContributor,
  TurnContextInput,
  TurnContextReplay,
} from './TurnContextContributor.ts';

export type BeginTurnContextInput = TurnContextInput;

/** Compose independently prepared domains without mixing their discovery or activation rules. */
export class PreparedTurnContext {
  constructor(
    readonly turnId: string,
    readonly contributions: ReadonlyMap<string, TurnContextContribution>,
  ) {}
  /** Collect only origins represented in this disclosure across the contributing domains. */
  disclosurePins(context?: TurnContextEnvelope) {
    return [...this.contributions.values()].flatMap(part => part.disclosurePins?.(context) ?? []);
  }
  /** Bind the replay policy applied to this request to its final transport handoff, including SDK retries. */
  prepareReplay(): TurnContextReplay & { readonly session: PreparedTurnContext } {
    const parts = [...this.contributions.values()].flatMap(part => part.prepareReplay?.() ?? []);
    const filters = parts.flatMap(part => part.filter ?? []);
    return {
      session: this,
      ...(filters.length > 0 && {
        filter: (context: TurnContextEnvelope) =>
          filters.reduce<TurnContextEnvelope | undefined>(
            (remaining, filter) => remaining && filter(remaining),
            context,
          ),
      }),
      assertCurrent: () => {
        for (const part of parts) part.assertCurrent();
      },
      didDeliver: () => {
        for (const part of parts) part.didDeliver();
      },
    };
  }
  checkpoint(): () => void {
    const restore = [...this.contributions.values()].flatMap(part =>
      part.checkpointSteering ? [part.checkpointSteering()] : [],
    );
    return () => {
      for (const run of restore.toReversed()) run();
    };
  }
  initialEnvelope(): TurnContextEnvelope {
    return mergeTurnContext([...this.contributions.values()].map(part => part.initialEnvelope()));
  }
  snapshot(): TurnContextSnapshot {
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
  private readonly disclosures = new WeakMap<PreparedTurnContext, TurnDisclosure>();
  private readonly pending = new Set<string>();
  private readonly contributors: readonly TurnContextContributor[];
  constructor(input: AgentInstructionCatalog | readonly TurnContextContributor[]) {
    this.contributors = 'refresh' in input ? [new InstructionContextContributor(input)] : input;
    if (new Set(this.contributors.map(part => part.id)).size !== this.contributors.length)
      throw new Error('Turn context contributor IDs must be unique.');
  }
  async beginTurn(input: BeginTurnContextInput, signal?: AbortSignal): Promise<PreparedTurnContext> {
    if (this.pending.has(input.turnId) || this.sessions.has(input.turnId))
      throw new Error('This turn already has an active instruction session.');
    if (this.pending.size + this.sessions.size >= 32)
      throw new Error('32 turns are already active. Retry when one completes.');
    this.pending.add(input.turnId);
    const parts = new Map<string, TurnContextContribution>();
    try {
      for (const contributor of this.contributors) {
        signal?.throwIfAborted();
        parts.set(contributor.id, await contributor.beginTurn(input, signal));
        signal?.throwIfAborted();
      }
      const session = new PreparedTurnContext(input.turnId, parts);
      const check = await authorizeSources(session.disclosurePins(), signal);
      check();
      this.disclosures.set(
        session,
        new TurnDisclosure(() => {
          if (this.sessions.get(input.turnId) !== session) throw new Error('This turn has ended.');
        }),
      );
      this.sessions.set(input.turnId, session);
      return session;
    } catch (error) {
      for (const part of parts.values()) part.release?.();
      throw error;
    } finally {
      this.pending.delete(input.turnId);
    }
  }
  /** Domains validate asynchronous selections before publishing synchronous path disclosures. */
  async steer(input: TurnContextInput, signal?: AbortSignal): Promise<TurnContextEnvelope | undefined> {
    const session = this.sessions.get(input.turnId);
    if (!session) return undefined;
    return this.disclosures.get(session)!.exclusive(async () => {
      const contributions = [...session.contributions.values()];
      signal?.throwIfAborted();
      const checkpoints = contributions.flatMap(part => (part.checkpointSteering ? [part.checkpointSteering()] : []));
      try {
        const contexts: TurnContextEnvelope[] = [];
        for (const part of contributions) {
          if (!part.steer) continue;
          const delta = await part.steer(input, signal);
          signal?.throwIfAborted();
          if (delta) contexts.push(delta);
        }
        for (const part of contributions) {
          if (part.steer) continue;
          const paths = part.discloseAttachments?.(input.attachmentPaths);
          const manual = part.activateManualRules?.(input.manualRuleIds ?? []);
          if (paths) contexts.push(paths);
          if (manual) contexts.push(manual);
        }
        const context = contexts.length > 0 ? mergeTurnContext(contexts) : undefined;
        const pins = context ? session.disclosurePins(context) : [];
        const commit = session.checkpoint();
        for (const restore of checkpoints.toReversed()) restore();
        const check = await authorizeSources(pins, signal);
        check();
        commit();
        return context;
      } catch (error) {
        for (const restore of checkpoints.toReversed()) restore();
        throw error;
      }
    });
  }
  disclosePaths(turnId: string, paths: readonly string[], signal?: AbortSignal) {
    return this.withPathInstructions(turnId, paths, context => context, signal);
  }
  /** Admit a project result and its scoped guidance in one synchronous delivery.
   * A failed result check leaves the instructions available to a later read or proposal. */
  withPathInstructions<T>(
    turnId: string,
    paths: readonly string[],
    deliver: (context: TurnContextEnvelope | undefined) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.disclose(turnId, part => part.disclosePaths?.(paths), deliver, signal);
  }
  discloseAttachments(turnId: string, paths: readonly string[], signal?: AbortSignal) {
    return this.disclose(
      turnId,
      part => part.discloseAttachments?.(paths),
      context => context,
      signal,
    );
  }
  activateManualRules(turnId: string, ids: readonly string[], signal?: AbortSignal) {
    return this.disclose(
      turnId,
      part => part.activateManualRules?.(ids),
      context => context,
      signal,
    );
  }
  activateRule(turnId: string, id: string, signal?: AbortSignal) {
    return this.disclose(
      turnId,
      part => part.activateRule?.(id, AgentInstructionActivationReason.MODEL),
      context => context,
      signal,
    );
  }
  async activateSource(
    turnId: string,
    contributorId: string,
    sourceId: string,
    reason: 'manual' | 'model',
    explanation: string,
    signal?: AbortSignal,
  ): Promise<TurnContextEnvelope | undefined> {
    const session = this.sessions.get(turnId);
    if (!session) return undefined;
    return this.disclosures.get(session)!.exclusive(async () => {
      const part = session.contributions.get(contributorId);
      const context = await part?.activateSource?.(sourceId, reason, explanation, signal);
      return prepareModelContext(context);
    });
  }
  contribution(turnId: string, id: string): TurnContextContribution | undefined {
    return this.sessions.get(turnId)?.contributions.get(id);
  }
  snapshot(turnId: string): TurnContextSnapshot | undefined {
    return this.sessions.get(turnId)?.snapshot();
  }
  completeTurn(turnId: string): TurnContextSnapshot | undefined {
    const snapshot = this.snapshot(turnId);
    this.discardTurn(turnId);
    return snapshot;
  }
  discardTurn(turnId: string): void {
    this.sessions.get(turnId)?.release();
    this.sessions.delete(turnId);
  }
  /** Reauthorize only the source material entering this provider request after async preparation. */
  authorizeDisclosure(
    turnId: string,
    signal?: AbortSignal,
    replay?: ReturnType<PreparedTurnContext['prepareReplay']>,
  ): Promise<() => void> {
    const session = this.sessions.get(turnId);
    if (!session || (replay && replay.session !== session)) throw new Error('This turn has ended.');
    return authorizeSources(session.disclosurePins(), signal).then(check => () => {
      if (this.sessions.get(turnId) !== session) throw new Error('This turn has ended.');
      replay?.assertCurrent();
      check();
    });
  }
  private async disclose<T>(
    turnId: string,
    operation: (part: TurnContextContribution) => TurnContextEnvelope | undefined,
    deliver: (context: TurnContextEnvelope | undefined) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    const session = this.sessions.get(turnId);
    if (!session) return deliver(undefined);
    return this.disclosures.get(session)!.publish(
      () => session.checkpoint(),
      () => {
        const parts = [...session.contributions.values()].flatMap(part => {
          const context = operation(part);
          return context ? [context] : [];
        });
        return prepareModelContext(mergeTurnContext(parts));
      },
      context => (context ? session.disclosurePins(context) : []),
      deliver,
      signal,
    );
  }
}

/** Preserve separate payloads for instruction and package domains in one versioned turn envelope. */
export function mergeTurnContext(parts: readonly TurnContextEnvelope[]): TurnContextEnvelope {
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
