import { enrollSources } from '#src/workspace/SourceDisclosure.js';
import { AgentInstructionSourceStatus } from '#src/instructions/AgentInstructionSource.js';
import type { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import { TurnContextSession } from './TurnContextSession.ts';
import type { TurnContextContributor, TurnContextInput } from './TurnContextContributor.ts';

/** Keeps AGENTS.md/rule discovery and activation behind the common turn-contributor boundary. */
export class InstructionContextContributor implements TurnContextContributor {
  readonly id = 'instructions';
  constructor(private readonly catalog: AgentInstructionCatalog) {}
  async beginTurn(input: TurnContextInput, signal?: AbortSignal): Promise<TurnContextSession> {
    const sources = await this.catalog.refresh(signal);
    return new TurnContextSession({
      turnId: input.turnId,
      sources,
      origins: await enrollSources(
        sources.filter(source => source.status === AgentInstructionSourceStatus.ACTIVE && source.enabled !== false),
        signal,
      ),
      paths: this.catalog.paths,
      scopeIndex: this.catalog.scopeIndex?.(sources),
      attachmentPaths: input.attachmentPaths,
      manualRuleIds: input.manualRuleIds ?? [],
    });
  }
}
