import type { AgentInstructionActivationReason } from '#src/instructions/AgentInstructionSource.js';
import type {
  AgentInstructionContext,
  AgentInstructionTurnSnapshot,
} from '#src/instructions/AgentInstructionSource.js';

/** Inputs common to all context domains prepared for a logical turn. */
export interface TurnContextInput {
  readonly turnId: string;
  readonly attachmentPaths: readonly string[];
  readonly manualRuleIds?: readonly string[];
  readonly skillIds?: readonly string[];
}

/** Frozen contribution. A domain owns activation semantics; the coordinator owns turn lifetime and composition. */
export interface TurnContextContribution {
  initialEnvelope(): AgentInstructionContext;
  snapshot(): AgentInstructionTurnSnapshot;
  disclosePaths?(paths: readonly string[]): AgentInstructionContext | undefined;
  discloseAttachments?(paths: readonly string[]): AgentInstructionContext | undefined;
  activateManualRules?(ids: readonly string[]): AgentInstructionContext | undefined;
  activateRule?(
    id: string,
    reason: AgentInstructionActivationReason.MODEL | AgentInstructionActivationReason.MANUAL,
  ): AgentInstructionContext | undefined;
  activateSource?(
    id: string,
    reason: 'manual' | 'model',
    explanation: string,
    signal?: AbortSignal,
  ): Promise<AgentInstructionContext | undefined>;
  /** Validate and prepare domain selections for an in-flight user instruction. */
  steer?(input: TurnContextInput, signal?: AbortSignal): Promise<AgentInstructionContext | undefined>;
  release?(): void;
}

/** Pluggable context preparation domain. No provider wire protocol or workbench dependency. */
export interface TurnContextContributor {
  readonly id: string;
  beginTurn(input: TurnContextInput, signal?: AbortSignal): Promise<TurnContextContribution>;
}
