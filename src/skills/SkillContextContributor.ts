import { authorizeSources, enrollSources, type SourcePin } from '#src/workspace/SourceDisclosure.js';
import {
  hasModelContext,
  type TurnContextEnvelope,
  type TurnContextSnapshot,
} from '#src/context/turns/TurnContextEnvelope.js';
import type {
  TurnContextContribution,
  TurnContextContributor,
  TurnContextInput,
  TurnContextReplay,
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
  private retired: ReadonlySet<string> = new Set();
  private readonly delivered = new Map<string, SkillActivation>();
  private released = false;
  private stopObserving?: () => void;
  private origins: ReadonlyMap<string, readonly SourcePin[]> = new Map();
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
    this.stopObserving = this.catalog.retirements.subscribe(id => {
      if (!this.retired.has(id) && this.descriptors.some(skill => skill.id === id)) {
        this.retired = new Set(this.retired).add(id);
      }
    });
    this.origins = await enrollSources(this.descriptors, signal);
    const activation = await this.activateManualSkills(ids, 'Selected by the user', signal);
    this.initialSkills = activation?.skills ?? [];
  }
  /** Collect the discovered manifest for advertisements and only the pinned package files
   * actually entering the provider input. Unopened resources remain outside each disclosure. */
  disclosurePins(context?: TurnContextEnvelope): SourcePin[] {
    const candidates = context ? (context.skillCandidates ?? []) : this.advertised.values();
    const result = [...candidates]
      .filter(candidate => context !== undefined || !this.retired.has(candidate.id))
      .flatMap(candidate => this.origins.get(candidate.id) ?? []);
    const ids = context ? (context.skills ?? []).map(skill => skill.descriptor.id) : this.packages.keys();
    for (const id of ids) {
      if (!context && this.retired.has(id)) continue;
      const active = this.packages.get(id)!.package;
      result.push(
        ...(this.origins.get(id) ?? []),
        ...active.disclosurePins(context ? [] : active.resources().map(resource => resource.path)),
      );
    }
    return result;
  }
  initialEnvelope(): TurnContextEnvelope {
    const skills = this.initialSkills.filter(skill => !this.retired.has(skill.descriptor.id));
    return {
      schema: 'glyph.agent-instructions.v1',
      sources: [],
      skillCandidates: this.initialCandidates.filter(candidate => !this.retired.has(candidate.id)),
      ...(skills.length > 0 ? { skills } : {}),
    };
  }
  disclosePaths(paths: readonly string[]): TurnContextEnvelope | undefined {
    if (this.advertised.size >= 50) return undefined;
    const candidates = this.catalog.applicableSkills(
      this.descriptors.filter(
        skill => !this.retired.has(skill.id) && !this.advertised.has(skill.id) && !this.packages.has(skill.id),
      ),
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
    if (!active || this.retired.has(id)) throw new Error('Activate the skill before reading package resources.');
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
      skills: [...this.delivered.values()],
    };
  }
  release(): void {
    this.stopObserving?.();
    this.released = true;
    this.packages.clear();
    this.advertised.clear();
    this.delivered.clear();
  }
  /** Freeze the packages and resource reads entering this step. Retirement of a different catalog entry
   * affects later selections. A successful response records just this request's admitted context. */
  prepareReplay(): TurnContextReplay {
    const retired = this.retired;
    const included = new Set([...this.advertised.keys(), ...this.packages.keys()].filter(id => !retired.has(id)));
    const activations: SkillActivation[] = [];
    for (const [id, active] of this.packages) {
      if (!included.has(id)) continue;
      activations.push({
        descriptor: active.package.descriptor,
        revision: active.package.revision,
        reason: active.reason,
        explanation: active.explanation,
        body: active.package.body,
        resources: active.package.resources(),
      });
    }
    return {
      ...(retired.size > 0 && { filter: (context: TurnContextEnvelope) => filterRetired(context, retired) }),
      assertCurrent: () => {
        if (this.retired !== retired && [...included].some(id => this.retired.has(id)))
          throw new Error('Instruction sources changed during request preparation.');
      },
      didDeliver: () => {
        for (const active of activations) this.delivered.set(active.descriptor.id, active);
      },
    };
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
      if (this.packages.has(id) && !this.retired.has(id)) continue;
      const descriptor = this.descriptors.find(skill => skill.id === id && !this.retired.has(id));
      if (reason === 'manual' && !descriptor)
        throw new Error('Selected skill is unavailable. Choose it again before sending.');
      if (descriptor && (reason === 'manual' || this.advertised.has(id))) selected.push(descriptor);
    }
    if (selected.length === 0) return undefined;
    if (reason === 'manual') {
      const names = new Set(
        [...this.packages].filter(([id]) => !this.retired.has(id)).map(([, active]) => active.package.descriptor.name),
      );
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
    const check = await authorizeSources(
      packages.flatMap(pkg => [...(this.origins.get(pkg.descriptor.id) ?? []), ...pkg.disclosurePins()]),
      signal,
    );
    check();
    if (this.released) throw new Error('Skill turn ended during activation.');
    if (selected.some(descriptor => this.retired.has(descriptor.id)))
      throw new Error('The selected skill changed during activation. Select it again in a new turn.');
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

function filterRetired(context: TurnContextEnvelope, retired: ReadonlySet<string>): TurnContextEnvelope | undefined {
  const remaining = {
    ...context,
    ...(context.skillCandidates && {
      skillCandidates: context.skillCandidates.filter(skill => !retired.has(skill.id)),
    }),
    ...(context.skills && { skills: context.skills.filter(skill => !retired.has(skill.descriptor.id)) }),
    ...(context.skillResources && {
      skillResources: context.skillResources.filter(resource => !retired.has(resource.skillId)),
    }),
  };
  return hasModelContext(remaining) ? remaining : undefined;
}
