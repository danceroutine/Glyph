import type { SkillDescriptor } from './SkillDescriptor.ts';
import type { SkillDiscoveryProvider } from './SkillDiscoveryProvider.ts';

/** Aggregates compatibility providers without hiding same-name packages from different origins. */
export class SkillCatalog {
  private generation = 0;
  private published = 0;
  private current: readonly SkillDescriptor[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly providers: readonly SkillDiscoveryProvider[],
    private readonly enabled: ReadonlyMap<string, boolean> = new Map(),
    private readonly installations: ReadonlyMap<string, { source: string; revision: string }> = new Map(),
    private readonly ensureReady?: () => Promise<void>,
  ) {
    if (new Set(providers.map(provider => provider.id)).size !== providers.length)
      throw new Error('Skill provider IDs must be unique.');
  }
  get skills(): readonly SkillDescriptor[] {
    return this.current;
  }
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async refresh(signal?: AbortSignal): Promise<readonly SkillDescriptor[]> {
    const generation = ++this.generation;
    let unavailable: { cause: unknown } | undefined;
    try {
      if (this.ensureReady) await this.ensureReady();
    } catch (cause) {
      unavailable = { cause };
    }
    const discovered = (
      await Promise.all(
        this.providers.map(async provider => {
          try {
            if (unavailable) throw unavailable.cause;
            return await provider.discover(signal);
          } catch (error) {
            if (signal?.aborted) throw signal.reason;
            return [
              {
                id: `${provider.id}:discovery-error`,
                origin: provider.origin,
                path: '',
                directory: '',
                scope: '.',
                name: provider.origin.label,
                description: '',
                enabled: false,
                status: 'discovery-error' as const,
                allowedTools: [],
                uri: '',
                message: error instanceof Error ? error.message : 'Skill discovery failed.',
              },
            ];
          }
        }),
      )
    )
      .flat()
      .map(skill => ({
        ...skill,
        ...(this.installations.has(skill.id)
          ? {
              installedFrom: this.installations.get(skill.id)!.source,
              packageRevision: this.installations.get(skill.id)!.revision,
            }
          : {}),
        enabled: skill.status === 'active' && (this.enabled.get(skill.id) ?? skill.enabled),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    signal?.throwIfAborted();
    if (generation < this.published) return this.current;
    this.published = generation;
    if (JSON.stringify(discovered) !== JSON.stringify(this.current)) {
      this.current = discovered;
      for (const listener of this.listeners) listener();
    }
    return this.current;
  }
  appliesTo(skill: SkillDescriptor, paths: readonly string[]): boolean {
    if (skill.scope === '.') return true;
    const provider = this.providers.find(candidate => candidate.id === skill.origin.id);
    const scope = provider?.scopePathKey?.(skill.scope) ?? skill.scope;
    return paths.some(path => {
      const key = provider?.scopePathKey?.(path) ?? path;
      return key === scope || key.startsWith(`${scope}/`);
    });
  }

  async capture(descriptor: SkillDescriptor, signal?: AbortSignal) {
    if (this.ensureReady) await this.ensureReady();
    if (!descriptor.enabled || descriptor.status !== 'active' || this.enabled.get(descriptor.id) === false)
      throw new Error('Skill is disabled or unavailable.');
    const provider = this.providers.find(candidate => candidate.id === descriptor.origin.id);
    if (!provider) throw new Error('Skill provider is unavailable.');
    return provider.capture(descriptor, signal);
  }
  async refreshIndexes(): Promise<void> {
    await Promise.all(this.providers.map(provider => provider.refreshIndex()));
  }
}
