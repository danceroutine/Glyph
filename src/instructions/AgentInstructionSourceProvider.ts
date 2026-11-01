import type { AgentInstructionSource } from './AgentInstructionSource.ts';

/** Discovery seam for repository instructions today and user/project rule providers later. */
export interface AgentInstructionSourceProvider {
  /** Discover every authoritative source inside this provider's authorized workspace boundary. */
  discover(signal?: AbortSignal): Promise<readonly AgentInstructionSource[]>;
}
