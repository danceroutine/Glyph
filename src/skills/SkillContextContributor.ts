import type { TurnContextEnvelope, TurnContextSnapshot } from '#src/context/turns/TurnContextEnvelope.js';
import type {
  TurnContextContribution,
  TurnContextContributor,
  TurnContextInput,
} from '#src/context/turns/TurnContextContributor.js';
import type { SkillCatalog } from './SkillCatalog.ts';
import type { SkillActivation, SkillCandidate, SkillDescriptor, SkillInstruction } from './SkillDescriptor.ts';
import type { SkillPackage } from './SkillPackage.ts';

/** Prepare metadata only; explicit and model selections share one package activation ledger. */
export class SkillContextContributor implements TurnContextContributor {
  readonly id = 'skills';
  constructor(private readonly catalog: SkillCatalog) {}
  async beginTurn(input: TurnContextInput, signal?: AbortSignal): Promise<SkillTurnContext> {
    const sources = await this.catalog.refresh(signal);
    const descriptors = sources.filter(skill => skill.enabled && skill.status === 'active');
    const candidates = this.catalog.applicableSkills(descriptors, input.attachmentPaths);
    const session = new SkillTurnContext(input.turnId, descriptors, candidates, this.catalog, sources);
    try {
      await session.initialize(input.skillIds ?? [], signal);
    } catch (error) {
      session.release();
      throw error;
    }
    return session;
  }
}

/** Owns pinned package revisions, on-demand resource disclosure, and activation provenance for one turn. */
export class SkillTurnContext implements TurnContextContribution {
  private packages = new Map<string, { package: SkillPackage; reason: 'manual' | 'model'; explanation: string }>();
  private pending: { ids: ReadonlySet<string>; result: Promise<TurnContextEnvelope> } | undefined;
  private advertised = new Map<string, SkillCandidate>();
  private readonly initialCandidates: readonly SkillCandidate[];
  private initialSkills: readonly SkillInstruction[] = [];
  private released = false;
  constructor(
    private readonly turnId: string,
    private readonly descriptors: readonly SkillDescriptor[],
    initial: readonly SkillDescriptor[],
    private readonly catalog: SkillCatalog,
    private readonly sources = descriptors,
  ) {
    this.initialCandidates = this.offerCandidates(initial);
  }
  async initialize(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    const activation = await this.activateManualSkills(ids, 'Selected by the user', signal);
    this.initialSkills = activation?.skills ?? [];
  }
  initialEnvelope(): TurnContextEnvelope {
    return {
      schema: 'glyph.agent-instructions.v1',
      sources: [],
      skillCandidates: this.initialCandidates,
      ...(this.initialSkills.length > 0 ? { skills: this.initialSkills } : {}),
    };
  }
  disclosePaths(paths: readonly string[]): TurnContextEnvelope | undefined {
    if (this.advertised.size >= 50) return undefined;
    const candidates = this.catalog.applicableSkills(
      this.descriptors.filter(skill => !this.advertised.has(skill.id) && !this.packages.has(skill.id)),
      paths,
    );
    const advertised = this.offerCandidates(candidates);
    return advertised.length > 0
      ? { schema: 'glyph.agent-instructions.v1', sources: [], skillCandidates: advertised }
      : undefined;
  }
  discloseAttachments(paths: readonly string[]): TurnContextEnvelope | undefined {
    return this.disclosePaths(paths);
  }
  checkpointSteering(): () => void {
    // Steering may pin new packages and advertise candidates. Existing resource disclosures remain unchanged.
    const packages = new Map(this.packages);
    const advertised = new Map(this.advertised);
    return () => {
      this.packages = packages;
      this.advertised = advertised;
    };
  }
  async steer(input: TurnContextInput, signal?: AbortSignal): Promise<TurnContextEnvelope | undefined> {
    const activation = await this.activateManualSkills(
      input.skillIds ?? [],
      'Selected by the user while steering',
      signal,
    );
    const candidates = this.discloseAttachments(input.attachmentPaths);
    return activation && candidates ? { ...activation, ...candidates } : (activation ?? candidates);
  }
  activateManualSkills(ids: readonly string[], explanation: string, signal?: AbortSignal) {
    return this.activate(ids, 'manual', explanation, signal);
  }
  activateSource(id: string, reason: 'manual' | 'model', explanation: string, signal?: AbortSignal) {
    return this.activate([id], reason, explanation, signal);
  }
  activePackage(id: string): SkillPackage {
    if (this.released) throw new Error('Skill turn has ended.');
    const active = this.packages.get(id);
    if (!active) throw new Error('Activate the skill before reading package resources.');
    return active.package;
  }
  readResource(id: string, path: string) {
    return this.activePackage(id).readResource(path);
  }
  snapshot(): TurnContextSnapshot {
    return {
      schema: 'glyph.turn-context.v1',
      turnId: this.turnId,
      sources: [],
      activations: [],
      candidates: [],
      skills: [...this.packages.values()].map(active => ({
        descriptor: active.package.descriptor,
        revision: active.package.revision,
        reason: active.reason,
        explanation: active.explanation,
        body: active.package.body,
        resources: active.package.resources(),
      })),
    };
  }
  release(): void {
    this.released = true;
    this.packages.clear();
    this.advertised.clear();
  }
  private async activate(
    requested: readonly string[],
    reason: SkillActivation['reason'],
    explanation: string,
    signal?: AbortSignal,
  ): Promise<TurnContextEnvelope | undefined> {
    const ids =
      reason === 'manual'
        ? [...new Set(requested.map(id => this.catalog.resolveReference(id, this.sources)?.id ?? id))]
        : requested;
    // A batch validates against all earlier committed selections and publishes its captures together.
    while (this.pending) {
      const pending = this.pending;
      if (ids.length > 0 && ids.every(id => pending.ids.has(id))) {
        await pending.result;
        signal?.throwIfAborted();
        return undefined;
      }
      await pending.result.catch(() => undefined);
    }
    signal?.throwIfAborted();
    if (this.released) throw new Error('Skill turn has ended.');
    const selected: SkillDescriptor[] = [];
    for (const id of ids) {
      if (this.packages.has(id)) continue;
      const descriptor = this.descriptors.find(skill => skill.id === id);
      if (reason === 'manual' && !descriptor)
        throw new Error('Selected skill is unavailable. Choose it again before sending.');
      if (descriptor && (reason === 'manual' || this.advertised.has(id))) selected.push(descriptor);
    }
    if (selected.length === 0) return undefined;
    if (reason === 'manual') {
      const names = new Set([...this.packages.values()].map(active => active.package.descriptor.name));
      for (const skill of selected) {
        if (names.has(skill.name))
          throw new Error('Selected same-name skills from different origins. Choose the intended package.');
        names.add(skill.name);
      }
    }
    if (this.packages.size + selected.length > 32) throw new Error('At most 32 skills may activate per turn.');
    this.pending = {
      ids: new Set(selected.map(skill => skill.id)),
      result: this.captureBatch(selected, reason, explanation, signal),
    };
    try {
      return await this.pending.result;
    } finally {
      this.pending = undefined;
    }
  }
  /** Bound metadata per turn while keeping the full catalog available for explicit user selection. */
  private offerCandidates(candidates: readonly SkillDescriptor[]): readonly SkillCandidate[] {
    let bytes = Buffer.byteLength(JSON.stringify([...this.advertised.values()]));
    const offered: SkillCandidate[] = [];
    for (const descriptor of candidates) {
      const candidate = modelDescriptor(descriptor);
      const size = Buffer.byteLength(JSON.stringify(candidate)) + 1;
      if (this.advertised.size >= 50 || bytes + size > 32 * 1024) continue;
      bytes += size;
      this.advertised.set(candidate.id, candidate);
      offered.push(candidate);
    }
    return offered;
  }

  private async captureBatch(
    selected: readonly SkillDescriptor[],
    reason: SkillActivation['reason'],
    explanation: string,
    signal?: AbortSignal,
  ): Promise<TurnContextEnvelope> {
    const packages: SkillPackage[] = [];
    for (const descriptor of selected) {
      const pinned = await this.catalog.capture(descriptor, signal);
      if (Buffer.byteLength(pinned.body) > 64 * 1024)
        throw new Error('Skill instructions exceed the 64 KiB activation budget.');
      packages.push(pinned);
    }
    signal?.throwIfAborted();
    if (this.released) throw new Error('Skill turn ended during activation.');
    const skills = packages.map(pinned => {
      const descriptor = pinned.descriptor;
      this.packages.set(descriptor.id, { package: pinned, reason, explanation });
      return {
        descriptor: modelDescriptor(descriptor),
        revision: pinned.revision,
        reason,
        explanation,
        body: pinned.body,
        ...(descriptor.compatibility ? { compatibility: descriptor.compatibility } : {}),
        ...(descriptor.allowedTools.length > 0 ? { allowedTools: descriptor.allowedTools } : {}),
      };
    });
    return { schema: 'glyph.agent-instructions.v1', sources: [], skills };
  }
}

function modelDescriptor({ id, name, description, scope, origin }: SkillDescriptor): SkillCandidate {
  return { id, name, description, scope, origin: { scope: origin.scope, compatibility: origin.compatibility } };
}
