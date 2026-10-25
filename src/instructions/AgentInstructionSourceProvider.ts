import type { AgentInstructionSource } from './AgentInstructionSource.ts';

/** Discovery seam for repository instructions today and user/project rule providers later. */
export interface AgentInstructionSourceProvider {
  /** Discover every authoritative source inside this provider's authorized workspace boundary. */
  discover(signal?: AbortSignal): Promise<readonly AgentInstructionSource[]>;
}

/** Turn-level port consumed by model adapters without depending on filesystem discovery. */
export interface AgentInstructionContextProvider {
  /** Return the complete catalog for compatibility and non-turn consumers. */
  context(signal?: AbortSignal): Promise<import('./AgentInstructionSource.ts').AgentInstructionContext>;
  /** Freeze a catalog snapshot for a turn and return only workspace-wide sources. */
  beginTurn?(
    turnId: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<import('./AgentInstructionSource.ts').AgentInstructionContext>;
}

/** Scoped disclosure port used by project tools after a turn snapshot has been frozen. */
export interface AgentInstructionDisclosureProvider {
  /** Return previously undisclosed sources that govern any target path, then mark them disclosed. */
  disclose(
    turnId: string,
    paths: readonly string[],
  ): import('./AgentInstructionSource.ts').AgentInstructionContext | undefined;
}
