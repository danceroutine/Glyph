import { authorizeSources, enrollSources } from '#src/workspace/SourceDisclosure.js';
import { TurnDisclosure } from './TurnDisclosure.ts';
import type { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import {
  AgentInstructionActivationReason,
  AgentInstructionSourceStatus,
} from '#src/instructions/AgentInstructionSource.js';
import type {
  AgentInstructionContext,
  AgentInstructionTurnSnapshot,
} from '#src/instructions/AgentInstructionSource.js';
import { TurnContextSession } from './TurnContextSession.ts';

/** Inputs required to freeze and prepare context for a logical model turn. */
export interface BeginTurnContextInput {
  readonly turnId: string;
  readonly attachmentPaths: readonly string[];
  readonly manualRuleIds?: readonly string[];
}

/** Coordinates frozen per-turn context independently of any model provider protocol. */
export class TurnContextCoordinator {
  private readonly sessions = new Map<string, TurnContextSession>();

  private readonly disclosures = new WeakMap<TurnContextSession, TurnDisclosure>();
  private readonly pending = new Set<string>();

  constructor(private readonly instructions: AgentInstructionCatalog) {}

  async beginTurn(input: BeginTurnContextInput, signal?: AbortSignal): Promise<TurnContextSession> {
    if (this.pending.has(input.turnId) || this.sessions.has(input.turnId))
      throw new Error('This turn already has an active instruction session.');
    if (this.pending.size + this.sessions.size >= 32)
      throw new Error('32 turns are already active. Retry when one completes.');
    this.pending.add(input.turnId);
    try {
      const sources = await this.instructions.refresh(signal);
      const session = new TurnContextSession({
        turnId: input.turnId,
        sources,
        origins: await enrollSources(
          sources.filter(source => source.status === AgentInstructionSourceStatus.ACTIVE && source.enabled !== false),
          signal,
        ),
        paths: this.instructions.paths,
        scopeIndex: this.instructions.scopeIndex?.(sources),
        attachmentPaths: input.attachmentPaths,
        manualRuleIds: input.manualRuleIds ?? [],
      });
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
    } finally {
      this.pending.delete(input.turnId);
    }
  }

  /** Disclose newly applicable instructions after project paths enter context. */
  disclosePaths(turnId: string, paths: readonly string[], signal?: AbortSignal) {
    return this.disclose(turnId, session => session.disclosePaths(paths), signal);
  }

  /** Disclose rules selected by attachments introduced while steering a live turn. */
  discloseAttachments(turnId: string, paths: readonly string[], signal?: AbortSignal) {
    return this.disclose(turnId, session => session.discloseAttachments(paths), signal);
  }

  /** Activate explicit manual rule selections introduced while steering. */
  activateManualRules(turnId: string, ruleIds: readonly string[], signal?: AbortSignal) {
    return this.disclose(turnId, session => session.activateManualRules(ruleIds), signal);
  }

  /** Activate a model-selected rule by stable identity. */
  activateRule(turnId: string, ruleId: string, signal?: AbortSignal) {
    return this.disclose(
      turnId,
      session => session.activateRule(ruleId, AgentInstructionActivationReason.MODEL),
      signal,
    );
  }

  /** Authorize all source material replayed by the provider, after asynchronous request preparation. */
  authorizeDisclosure(turnId: string, signal?: AbortSignal): Promise<() => void> {
    const session = this.sessions.get(turnId);
    if (!session) throw new Error('This turn has ended.');
    return authorizeSources(session.disclosurePins(), signal).then(check => () => {
      if (this.sessions.get(turnId) !== session) throw new Error('This turn has ended.');
      check();
    });
  }

  /** Snapshot a live turn without removing it, for durable checkpoints and inspection. */
  snapshot(turnId: string): AgentInstructionTurnSnapshot | undefined {
    return this.sessions.get(turnId)?.snapshot();
  }

  /** Return the final snapshot and release live activation state. */
  completeTurn(turnId: string): AgentInstructionTurnSnapshot | undefined {
    const snapshot = this.snapshot(turnId);
    this.sessions.delete(turnId);
    return snapshot;
  }

  /** Release context for a failed or cancelled turn without publishing a completed snapshot. */
  discardTurn(turnId: string): void {
    this.sessions.delete(turnId);
  }

  private async disclose(
    turnId: string,
    operation: (session: TurnContextSession) => AgentInstructionContext | undefined,
    signal?: AbortSignal,
  ): Promise<AgentInstructionContext | undefined> {
    const session = this.sessions.get(turnId);
    if (!session) return undefined;
    return this.disclosures.get(session)!.publish(
      () => session.checkpointSteering(),
      () => operation(session),
      context => (context ? session.disclosurePins(context) : []),
      signal,
    );
  }
}
