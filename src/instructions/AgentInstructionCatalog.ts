import type { AgentInstructionSource } from './AgentInstructionSource.ts';
import { AgentInstructionSet } from './AgentInstructionSet.ts';
import type { AgentInstructionSourceProvider } from './AgentInstructionSourceProvider.ts';

/** Aggregates instruction providers and retains only the latest complete discovery snapshot. */
export class AgentInstructionCatalog {
  private current = new AgentInstructionSet([]);
  private readonly listeners = new Set<(sources: readonly AgentInstructionSource[]) => void>();

  constructor(private readonly providers: readonly AgentInstructionSourceProvider[]) {}

  get sources(): readonly AgentInstructionSource[] {
    return this.current.sources;
  }

  onDidChange(listener: (sources: readonly AgentInstructionSource[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async refresh(signal?: AbortSignal): Promise<readonly AgentInstructionSource[]> {
    signal?.throwIfAborted();
    const discovered = new AgentInstructionSet(
      (await Promise.all(this.providers.map(provider => provider.discover(signal)))).flat(),
    );
    signal?.throwIfAborted();
    if (JSON.stringify(discovered.sources) !== JSON.stringify(this.current.sources)) {
      this.current = discovered;
      for (const listener of this.listeners) listener(this.current.sources);
    }
    return this.current.sources;
  }

  /** Resolves the ancestor chain for a target; later entries have nearer scope and higher precedence. */
  resolve(path: string, sources?: readonly AgentInstructionSource[]): readonly AgentInstructionSource[] {
    return (sources ? new AgentInstructionSet(sources) : this.current).forPath(path);
  }
}
