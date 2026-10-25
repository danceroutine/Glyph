import {
  AgentInstructionSourceStatus,
  type AgentInstructionContext,
  type AgentInstructionSource,
} from './AgentInstructionSource.ts';
import type {
  AgentInstructionContextProvider,
  AgentInstructionSourceProvider,
} from './AgentInstructionSourceProvider.ts';

/** Aggregates instruction providers and retains only the latest complete discovery snapshot. */
export class AgentInstructionCatalog implements AgentInstructionContextProvider {
  private current: readonly AgentInstructionSource[] = [];
  private readonly listeners = new Set<(sources: readonly AgentInstructionSource[]) => void>();
  private readonly turns = new Map<
    string,
    { readonly sources: readonly AgentInstructionSource[]; readonly disclosed: Set<string> }
  >();

  constructor(private readonly providers: readonly AgentInstructionSourceProvider[]) {}

  get sources(): readonly AgentInstructionSource[] {
    return this.current;
  }

  onDidChange(listener: (sources: readonly AgentInstructionSource[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async context(signal?: AbortSignal): Promise<AgentInstructionContext> {
    const sources = await this.refresh(signal);
    return { schema: 'glyph.agent-instructions.v1', sources };
  }

  /** Freeze discovery for one tool loop and disclose only workspace-wide guidance up front. */
  async beginTurn(turnId: string, paths: readonly string[], signal?: AbortSignal): Promise<AgentInstructionContext> {
    const sources = await this.refresh(signal);
    const roots = sources.filter(source => source.scope === '.' || paths.some(path => contains(source.scope, path)));
    this.turns.delete(turnId);
    this.turns.set(turnId, { sources, disclosed: new Set(roots.map(source => source.id)) });
    while (this.turns.size > 32) this.turns.delete(this.turns.keys().next().value!);
    return { schema: 'glyph.agent-instructions.v1', sources: roots };
  }

  /** Disclose each applicable source at most once in a frozen turn. */
  disclose(turnId: string, paths: readonly string[]): AgentInstructionContext | undefined {
    const turn = this.turns.get(turnId);
    if (!turn) return undefined;
    const sources = turn.sources.filter(
      source => !turn.disclosed.has(source.id) && paths.some(path => contains(source.scope, path)),
    );
    if (sources.length === 0) return undefined;
    for (const source of sources) turn.disclosed.add(source.id);
    return { schema: 'glyph.agent-instructions.v1', sources };
  }

  async refresh(signal?: AbortSignal): Promise<readonly AgentInstructionSource[]> {
    signal?.throwIfAborted();
    const discovered = (await Promise.all(this.providers.map(provider => provider.discover(signal))))
      .flat()
      .toSorted(compareSources);
    signal?.throwIfAborted();
    if (JSON.stringify(discovered) !== JSON.stringify(this.current)) {
      this.current = discovered;
      for (const listener of this.listeners) listener(this.current);
    }
    return this.current;
  }

  /** Resolves the ancestor chain for a target; later entries have nearer scope and higher precedence. */
  resolve(path: string, sources: readonly AgentInstructionSource[] = this.current): readonly AgentInstructionSource[] {
    return sources
      .filter(source => source.status === AgentInstructionSourceStatus.ACTIVE && contains(source.scope, path))
      .toSorted(compareSources);
  }
}

function contains(scope: string, path: string): boolean {
  return scope === '.' || path === scope || path.startsWith(`${scope}/`);
}

function compareSources(left: AgentInstructionSource, right: AgentInstructionSource): number {
  return left.scope.split('/').length - right.scope.split('/').length || left.path.localeCompare(right.path);
}
