import type {
  TurnContextContribution,
  TurnContextContributor,
  TurnContextInput,
} from '#src/context/turns/TurnContextContributor.js';
import type {
  AgentInstructionContext,
  AgentInstructionTurnSnapshot,
} from '#src/instructions/AgentInstructionSource.js';
import type { SkillCatalog } from './SkillCatalog.ts';
import type { SkillActivation, SkillDescriptor } from './SkillDescriptor.ts';
import type { SkillPackage } from './SkillPackage.ts';

/** Prepare metadata only; explicit and model selections share one package activation ledger. */
export class SkillContextContributor implements TurnContextContributor {
  readonly id = 'skills';
  constructor(private readonly catalog: SkillCatalog) {}
  async beginTurn(input: TurnContextInput, signal?: AbortSignal): Promise<SkillTurnContext> {
    const descriptors = (await this.catalog.refresh(signal)).filter(
      skill => skill.enabled && skill.status === 'active',
    );
    const candidates = descriptors.filter(
      skill =>
        skill.scope === '.' ||
        input.attachmentPaths.some(path => path === skill.scope || path.startsWith(`${skill.scope}/`)),
    );
    const selected = descriptors.filter(skill => input.skillIds?.includes(skill.id));
    if (new Set(selected.map(skill => skill.name)).size !== selected.length)
      throw new Error('Selected same-name skills from different origins. Choose the intended package.');
    const session = new SkillTurnContext(input.turnId, descriptors, candidates, this.catalog);
    try {
      for (const id of new Set(input.skillIds ?? []))
        await session.activateSource(id, 'manual', 'Selected by the user', signal);
    } catch (error) {
      session.release();
      throw error;
    }
    return session;
  }
}

/** Owns pinned package revisions, on-demand resource disclosure, and activation provenance for one turn. */
export class SkillTurnContext implements TurnContextContribution {
  private readonly packages = new Map<
    string,
    { package: SkillPackage; reason: 'manual' | 'model'; explanation: string }
  >();
  private readonly pending = new Map<string, Promise<AgentInstructionContext | undefined>>();
  private readonly advertised = new Map<string, SkillDescriptor>();
  private readonly initialSkills: SkillActivation[] = [];
  private released = false;
  constructor(
    private readonly turnId: string,
    private readonly descriptors: readonly SkillDescriptor[],
    initial: readonly SkillDescriptor[],
    private readonly catalog: SkillCatalog,
  ) {
    this.offerCandidates(initial);
  }
  initialEnvelope(): AgentInstructionContext {
    return {
      schema: 'glyph.agent-instructions.v1',
      sources: [],
      skillCandidates: [...this.advertised.values()],
      ...(this.initialSkills.length > 0 ? { skills: this.initialSkills } : {}),
    };
  }
  disclosePaths(paths: readonly string[]): AgentInstructionContext | undefined {
    const candidates = this.descriptors.filter(
      skill =>
        !this.advertised.has(skill.id) &&
        paths.some(path => skill.scope === '.' || path === skill.scope || path.startsWith(`${skill.scope}/`)),
    );
    const advertised = this.offerCandidates(candidates);
    return advertised.length > 0
      ? { schema: 'glyph.agent-instructions.v1', sources: [], skillCandidates: advertised }
      : undefined;
  }
  discloseAttachments(paths: readonly string[]): AgentInstructionContext | undefined {
    return this.disclosePaths(paths);
  }
  activateSource(
    id: string,
    reason: 'manual' | 'model',
    explanation: string,
    signal?: AbortSignal,
  ): Promise<AgentInstructionContext | undefined> {
    if (this.released) return Promise.reject(new Error('Skill turn has ended.'));
    const existing = this.pending.get(id);
    if (existing) return existing.then(() => undefined);
    if (this.packages.has(id)) return Promise.resolve(undefined);
    const descriptor = this.descriptors.find(skill => skill.id === id);
    if (!descriptor) {
      return reason === 'manual'
        ? Promise.reject(new Error('Selected skill is unavailable. Choose it again before sending.'))
        : Promise.resolve(undefined);
    }
    if (reason === 'model' && !this.advertised.has(id)) return Promise.resolve(undefined);
    const activation = this.capture(descriptor, reason, explanation, signal);
    this.pending.set(id, activation);
    return activation.finally(() => {
      this.pending.delete(id);
    });
  }
  readResource(id: string, path: string) {
    if (this.released) throw new Error('Skill turn has ended.');
    const active = this.packages.get(id);
    if (!active) throw new Error('Activate the skill before reading package resources.');
    return active.package.readResource(path);
  }
  snapshot(): AgentInstructionTurnSnapshot {
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
  /** Bound metadata per turn while keeping the full catalog available for explicit user selection. */
  private offerCandidates(candidates: readonly SkillDescriptor[]): readonly SkillDescriptor[] {
    let bytes = Buffer.byteLength(JSON.stringify([...this.advertised.values()]));
    const offered: SkillDescriptor[] = [];
    for (const candidate of candidates) {
      const size = Buffer.byteLength(JSON.stringify(candidate)) + 1;
      if (this.advertised.size >= 50 || bytes + size > 32 * 1024) continue;
      bytes += size;
      this.advertised.set(candidate.id, candidate);
      offered.push(candidate);
    }
    return offered;
  }

  private async capture(
    descriptor: SkillDescriptor,
    reason: 'manual' | 'model',
    explanation: string,
    signal?: AbortSignal,
  ): Promise<AgentInstructionContext> {
    if (this.packages.size + this.pending.size >= 32) throw new Error('At most 32 skills may activate per turn.');
    const pinned = await this.catalog.capture(descriptor, signal);
    if (Buffer.byteLength(pinned.body) > 64 * 1024)
      throw new Error('Skill instructions exceed the 64 KiB activation budget.');
    signal?.throwIfAborted();
    if (this.released) throw new Error('Skill turn ended during activation.');
    this.packages.set(descriptor.id, { package: pinned, reason, explanation });
    const activation: SkillActivation = {
      descriptor,
      revision: pinned.revision,
      reason,
      explanation,
      body: pinned.body,
      resources: [],
    };
    if (reason === 'manual') this.initialSkills.push(activation);
    return { schema: 'glyph.agent-instructions.v1', sources: [], skills: [activation] };
  }
}
