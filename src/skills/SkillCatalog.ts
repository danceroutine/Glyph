import type { SkillDescriptor } from './SkillDescriptor.ts';
import type { SkillDiscoveryProvider } from './SkillDiscoveryProvider.ts';

/** Aggregates compatibility providers without hiding same-name packages from different origins. */
export class SkillCatalog {
  private readonly byId: ReadonlyMap<string, SkillDiscoveryProvider>;
  private generation = 0;
  private published = 0;
  private discovered: readonly SkillDescriptor[] = [];
  private current: readonly SkillDescriptor[] = [];
  private unsubscribePreferences: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  constructor(
    private readonly providers: readonly SkillDiscoveryProvider[],
    private readonly enabled: ReadonlyMap<string, boolean> = new Map(),
    private readonly installations: ReadonlyMap<string, { source: string; revision: string }> = new Map(),
    private readonly ensureReady?: () => Promise<void>,
    private readonly ensureLocation?: (originId: string, directory?: string) => Promise<void>,
    private observePreferences?: (listener: () => void) => () => void,
    private readonly workspaceRoutes?: {
      equivalents(path: string): string[];
      prepare?(paths: readonly string[]): void;
    },
    private readonly migratePreferences?: (skills: readonly SkillDescriptor[]) => Promise<void>,
    /** Invalidate the host's previous alias snapshot. Each provider establishes ownership inside its discovery call. */
    private readonly beforeDiscovery?: () => void,
  ) {
    this.byId = new Map(providers.map(provider => [provider.id, provider]));
    if (this.byId.size !== providers.length) throw new Error('Skill provider IDs must be unique.');
  }
  dispose(): void {
    this.observePreferences = undefined;
    this.unsubscribePreferences?.();
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
    // A catalog starts observing its shared profile when it first acquires workspace data.
    if (this.observePreferences) {
      this.unsubscribePreferences = this.observePreferences(() => {
        this.refreshPreferences();
      });
      this.observePreferences = undefined;
    }
    const generation = ++this.generation;
    let unavailable: { cause: unknown } | undefined;
    try {
      if (this.ensureReady) await this.ensureReady();
    } catch (cause) {
      unavailable = { cause };
    }
    this.beforeDiscovery?.();
    const discovered = (
      await Promise.all(
        this.providers.map(async provider => {
          try {
            if (unavailable) throw unavailable.cause;
            if (this.ensureLocation) await this.ensureLocation(provider.id);
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
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    signal?.throwIfAborted();
    if (generation < this.published) return this.current;
    // A package indexed through overlapping roots belongs to the most specific provider that found it.
    const unique = new Map<string, SkillDescriptor>();
    for (const skill of discovered) {
      const previous = unique.get(skill.id);
      if (!previous || skill.directory.length < previous.directory.length) unique.set(skill.id, skill);
    }
    if (this.migratePreferences) await this.migratePreferences([...unique.values()]);
    signal?.throwIfAborted();
    if (generation < this.published) return this.current;
    this.published = generation;
    this.discovered = [...unique.values()];
    this.refreshPreferences();
    return this.current;
  }
  /** Current IDs take precedence. Historical references must identify a single current package. */
  resolveReference(id: string, sources: readonly SkillDescriptor[] = this.current): SkillDescriptor | undefined {
    if (typeof id !== 'string' || !id || id.length > 500) return undefined;
    let source = sources.find(skill => skill.id === id);
    if (!source) {
      // Share a fixed probe allowance across every package and hashed ancestor in this lookup.
      const budget = { remaining: 32_768 };
      for (const skill of sources) {
        budget.remaining--;
        const provider = this.byId.get(skill.origin.id);
        let matched: boolean | undefined;
        try {
          matched = provider?.matchesLegacyId?.(skill.directory, id, budget);
        } catch {
          // A failed ownership query leaves the historical reference ambiguous across providers.
          return undefined;
        }
        if (budget.remaining <= 0) return undefined;
        if (!matched) continue;
        if (source) return undefined;
        source = skill;
      }
    }
    return source;
  }

  /** Match one batch of paths against each provider's scope hierarchy, retaining catalog precedence. */
  applicableSkills(skills: readonly SkillDescriptor[], paths: readonly string[]): readonly SkillDescriptor[] {
    if (paths.length === 0) return skills.filter(skill => skill.scope === '.');
    this.workspaceRoutes?.prepare?.([...new Set([...paths, ...skills.map(skill => skill.scope)])]);
    let routes: Set<string> | undefined;
    const byOrigin = new Map<string, { ancestors: Set<string>; scopes: Map<string, boolean> }>();
    return skills.filter(skill => {
      if (skill.scope === '.') return true;
      const provider = this.byId.get(skill.origin.id);
      const key = (path: string) => provider?.scopePathKey?.(path) ?? path;
      let index = byOrigin.get(skill.origin.id);
      if (!index) {
        const ancestors = new Set<string>();
        routes ??= new Set([...new Set(paths)].flatMap(path => this.workspaceRoutes?.equivalents(path) ?? [path]));
        for (const route of routes) {
          let scope = key(route);
          while (!ancestors.has(scope)) {
            ancestors.add(scope);
            const slash = scope.lastIndexOf('/');
            if (slash < 0) break;
            scope = scope.slice(0, slash);
          }
        }
        index = { ancestors, scopes: new Map() };
        byOrigin.set(skill.origin.id, index);
      }
      let matches = index.scopes.get(skill.scope);
      if (matches === undefined) {
        matches = index.ancestors.has(key(skill.scope));
        index.scopes.set(skill.scope, matches);
      }
      return matches;
    });
  }

  async capture(descriptor: SkillDescriptor, signal?: AbortSignal) {
    if (this.ensureReady) await this.ensureReady();
    if (!descriptor.enabled || descriptor.status !== 'active' || this.enabled.get(descriptor.id) === false)
      throw new Error('Skill is disabled or unavailable.');
    const provider = this.byId.get(descriptor.origin.id);
    if (!provider) throw new Error('Skill provider is unavailable.');
    const reconcile = this.ensureLocation?.bind(this, provider.id, descriptor.directory);
    if (reconcile) await reconcile();
    const snapshot = await provider.capture(descriptor, signal, reconcile);
    if (this.enabled.get(descriptor.id) === false) throw new Error('Skill was disabled during capture.');
    return snapshot;
  }
  async refreshIndexes(): Promise<void> {
    await Promise.all(this.providers.map(provider => provider.refreshIndex()));
  }
  private refreshPreferences(): void {
    const projected = this.discovered.map(skill => ({
      ...skill,
      ...(this.installations.has(skill.id)
        ? {
            installedFrom: this.installations.get(skill.id)!.source,
            packageRevision: this.installations.get(skill.id)!.revision,
          }
        : {}),
      enabled: skill.status === 'active' && (this.enabled.get(skill.id) ?? skill.enabled),
    }));
    // Source identities can change while the public settings metadata stays identical.
    const changed = JSON.stringify(projected) !== JSON.stringify(this.current);
    this.current = projected;
    if (changed) {
      for (const listener of this.listeners) listener();
    }
  }
}
