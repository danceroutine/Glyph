import type { SourcePin } from '#src/workspace/SourceDisclosure.js';
import type { TurnContextEnvelope, TurnContextSnapshot } from './TurnContextEnvelope.ts';
import type { AgentInstructionActivationReason } from '#src/instructions/AgentInstructionSource.js';

/** Inputs common to all context domains prepared for a logical turn. */
export interface TurnContextInput {
  readonly turnId: string;
  readonly attachmentPaths: readonly string[];
  readonly manualRuleIds?: readonly string[];
  readonly skillIds?: readonly string[];
}

/** Frozen contribution. A domain owns activation semantics; the coordinator owns turn lifetime and composition. */
export interface TurnContextContribution {
  /** The selected source origins for one delta, or every origin replayed in the current provider input. */
  disclosurePins?(context?: TurnContextEnvelope): readonly SourcePin[];
  initialEnvelope(): TurnContextEnvelope;
  snapshot(): TurnContextSnapshot;
  disclosePaths?(paths: readonly string[]): TurnContextEnvelope | undefined;
  discloseAttachments?(paths: readonly string[]): TurnContextEnvelope | undefined;
  activateManualRules?(ids: readonly string[]): TurnContextEnvelope | undefined;
  activateRule?(
    id: string,
    reason: AgentInstructionActivationReason.MODEL | AgentInstructionActivationReason.MANUAL,
  ): TurnContextEnvelope | undefined;
  activateSource?(
    id: string,
    reason: 'manual' | 'model',
    explanation: string,
    signal?: AbortSignal,
  ): Promise<TurnContextEnvelope | undefined>;
  /** Capture mutable disclosure state before steering. Restore it if another domain rejects the request. */
  checkpointSteering?(): () => void;
  /** Validate and prepare domain selections for an in-flight user instruction. */
  steer?(input: TurnContextInput, signal?: AbortSignal): Promise<TurnContextEnvelope | undefined>;
  release?(): void;
}

/** Pluggable context preparation domain. No provider wire protocol or workbench dependency. */
export interface TurnContextContributor {
  readonly id: string;
  beginTurn(input: TurnContextInput, signal?: AbortSignal): Promise<TurnContextContribution>;
}
