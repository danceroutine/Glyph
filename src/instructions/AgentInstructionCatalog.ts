import { defaultInstructionPaths } from './InstructionPaths.ts';
import type { AgentInstructionSource } from './AgentInstructionSource.ts';
import { AgentInstructionSet } from './AgentInstructionSet.ts';
import type { AgentInstructionSourceProvider } from './AgentInstructionSourceProvider.ts';

/** Aggregates instruction providers and retains only the latest complete discovery snapshot. */
export class AgentInstructionCatalog {
  private generation = 0;
  private published = 0;
  private current = new AgentInstructionSet([]);
  private readonly listeners = new Set<(sources: readonly AgentInstructionSource[]) => void>();

  constructor(
    private readonly providers: readonly AgentInstructionSourceProvider[],
    readonly paths = defaultInstructionPaths,
    private readonly beforeDiscovery?: () => void,
  ) {}

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
    const generation = ++this.generation;
    this.beforeDiscovery?.();
    const discovered = new AgentInstructionSet(
      (await Promise.all(this.providers.map(provider => provider.discover(signal)))).flat(),
      this.paths,
    );
    signal?.throwIfAborted();
    if (generation < this.published) return this.current.sources;
    this.published = generation;
    const changed = JSON.stringify(discovered.sources) !== JSON.stringify(this.current.sources);
    // Equal bytes can belong to a replacement route. Keep the current read receipts even when the UI is unchanged.
    this.current = discovered;
    if (changed) {
      for (const listener of this.listeners) listener(this.current.sources);
    }
    return this.current.sources;
  }

  /** Resolves the ancestor chain for a target; later entries have nearer scope and higher precedence. */
  resolve(path: string, sources?: readonly AgentInstructionSource[]): readonly AgentInstructionSource[] {
    return this.scopeIndex(sources).forPath(path);
  }

  /** A turn keeps the ancestor index belonging to the same immutable discovery result. */
  scopeIndex(sources: readonly AgentInstructionSource[] = this.sources): AgentInstructionSet {
    return sources === this.sources ? this.current : new AgentInstructionSet(sources, this.paths);
  }
}
