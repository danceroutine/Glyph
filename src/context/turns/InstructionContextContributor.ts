import type { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import { TurnContextSession } from './TurnContextSession.ts';
import type { TurnContextContributor, TurnContextInput } from './TurnContextContributor.ts';

/** Keeps AGENTS.md/rule discovery and activation behind the common turn-contributor boundary. */
export class InstructionContextContributor implements TurnContextContributor {
  readonly id = 'instructions';
  constructor(private readonly catalog: AgentInstructionCatalog) {}
  async beginTurn(input: TurnContextInput, signal?: AbortSignal): Promise<TurnContextSession> {
    return new TurnContextSession({
      turnId: input.turnId,
      sources: await this.catalog.refresh(signal),
      attachmentPaths: input.attachmentPaths,
      manualRuleIds: input.manualRuleIds ?? [],
    });
  }
}
