import type { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import { AgentInstructionActivationReason } from '#src/instructions/AgentInstructionSource.js';
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

  constructor(private readonly instructions: AgentInstructionCatalog) {}

  async beginTurn(input: BeginTurnContextInput, signal?: AbortSignal): Promise<TurnContextSession> {
    const sources = await this.instructions.refresh(signal);
    const session = new TurnContextSession({
      turnId: input.turnId,
      sources,
      attachmentPaths: input.attachmentPaths,
      manualRuleIds: input.manualRuleIds ?? [],
    });
    this.sessions.delete(input.turnId);
    this.sessions.set(input.turnId, session);
    while (this.sessions.size > 32) this.sessions.delete(this.sessions.keys().next().value!);
    return session;
  }

  /** Disclose newly applicable instructions after project paths enter context. */
  disclosePaths(turnId: string, paths: readonly string[]): AgentInstructionContext | undefined {
    return this.sessions.get(turnId)?.disclosePaths(paths);
  }

  /** Disclose rules selected by attachments introduced while steering a live turn. */
  discloseAttachments(turnId: string, paths: readonly string[]): AgentInstructionContext | undefined {
    return this.sessions.get(turnId)?.discloseAttachments(paths);
  }

  /** Activate explicit manual rule selections introduced while steering. */
  activateManualRules(turnId: string, ruleIds: readonly string[]): AgentInstructionContext | undefined {
    return this.sessions.get(turnId)?.activateManualRules(ruleIds);
  }

  /** Activate a model-selected rule by stable identity. */
  activateRule(turnId: string, ruleId: string): AgentInstructionContext | undefined {
    return this.sessions.get(turnId)?.activateRule(ruleId, AgentInstructionActivationReason.MODEL);
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
}
