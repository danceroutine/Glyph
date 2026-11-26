import type { SkillDescriptor } from './SkillDescriptor.ts';
import type { SkillDiscoveryProvider } from './SkillDiscoveryProvider.ts';

/** Aggregates compatibility providers without hiding same-name packages from different origins. */
export class SkillCatalog {
  private current: readonly SkillDescriptor[] = [];
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly providers: readonly SkillDiscoveryProvider[],
    private readonly enabled: ReadonlyMap<string, boolean> = new Map(),
    private readonly installations: ReadonlyMap<string, { source: string; revision: string }> = new Map(),
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
    const discovered = (
      await Promise.all(
        this.providers.map(async provider => {
          try {
            return await provider.discover(signal);
          } catch (error) {
            if (signal?.aborted) throw signal.reason;
            return [
              {
                id: `${provider.id}:discovery-error`,
                origin: { id: provider.id, label: provider.id, scope: 'project' as const, compatibility: 'unknown' },
                path: '',
                directory: '',
                scope: '.',
                name: provider.id,
                description: '',
                enabled: false,
                status: 'error' as const,
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
    if (JSON.stringify(discovered) !== JSON.stringify(this.current)) {
      this.current = discovered;
      for (const listener of this.listeners) listener();
    }
    return this.current;
  }
  async capture(descriptor: SkillDescriptor, signal?: AbortSignal) {
    if (!descriptor.enabled || descriptor.status !== 'active') throw new Error('Skill is disabled or unavailable.');
    const provider = this.providers.find(candidate => candidate.id === descriptor.origin.id);
    if (!provider) throw new Error('Skill provider is unavailable.');
    return provider.capture(descriptor, signal);
  }
  async refreshIndexes(): Promise<void> {
    await Promise.all(this.providers.map(provider => provider.refreshIndex()));
  }
}
