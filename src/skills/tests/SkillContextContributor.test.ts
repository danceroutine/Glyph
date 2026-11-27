import type { AgentInstructionContext } from '#src/instructions/AgentInstructionSource.js';
import type { SkillResourceUse } from '#src/skills/SkillDescriptor.js';
import { describe, expect, it, vi } from 'vitest';
import { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import { SkillContextContributor, SkillTurnContext } from '#src/skills/SkillContextContributor.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';
import type { SkillDiscoveryProvider } from '#src/skills/SkillDiscoveryProvider.js';
import { SkillToolRuntime } from '#src/skills/SkillToolRuntime.js';
import { aSkillDescriptor, aSkillPackage } from './fixtures/aSkillDescriptor.ts';

describe(SkillContextContributor, () => {
  it('resolves only unambiguous manual references without exposing old identities to the model', async () => {
    const skill = aSkillDescriptor();
    const other = aSkillDescriptor({ id: 'other', name: 'other', directory: 'other' });
    const inactive = aSkillDescriptor({ id: 'disabled', directory: 'disabled', enabled: false });
    const capture = vi.fn(async () => aSkillPackage(skill));
    const catalog = new SkillCatalog([
      {
        id: skill.origin.id,
        origin: skill.origin,
        capture,
        refreshIndex: async () => {},
        discover: async () => [skill, other, inactive],
        matchesLegacyId: (directory, id, budget) => {
          if (id === 'exhausted') budget.remaining = 0;
          return id === 'ambiguous' || (id === 'historical' && directory === skill.directory);
        },
      },
    ]);
    const session = await new SkillContextContributor(catalog).beginTurn({ turnId: 'turn', attachmentPaths: [] });
    for (const id of [null, '', 'x'.repeat(501), 'ambiguous', 'exhausted']) {
      expect(catalog.resolveReference(id as string)).toBeUndefined();
    }
    expect(catalog.resolveReference('disabled')).toMatchObject({ enabled: false });
    await expect(session.activateManualSkills(['disabled'], 'select')).rejects.toThrow('unavailable');
    expect(
      catalog.resolveReference('missing', [aSkillDescriptor({ origin: { ...skill.origin, id: 'gone' } })]),
    ).toBeUndefined();
    expect(await session.activateSource('historical', 'model', 'try')).toBeUndefined();
    expect(await session.activateManualSkills(['historical', skill.id], 'Selected')).toMatchObject({
      skills: [{ descriptor: { id: skill.id } }],
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([session.initialEnvelope(), session.snapshot()])).not.toContain('historical');
  });
  it('advertises metadata, loads only a selected body, and records only accessed resources', async () => {
    const descriptor = aSkillDescriptor();
    const capture = vi.fn<SkillDiscoveryProvider['capture']>(async source =>
      aSkillPackage(source, 'SELECTED BODY', {
        'references/example.md': Buffer.from('REFERENCE BODY'),
        'assets/image.bin': Buffer.from([0, 255, 0]),
      }),
    );
    const provider: SkillDiscoveryProvider = {
      id: 'project',
      origin: aSkillDescriptor().origin,
      discover: vi.fn(async () => [
        descriptor,
        aSkillDescriptor({ id: 'disabled', enabled: false }),
        aSkillDescriptor({ id: 'invalid', status: 'error' }),
      ]),
      capture,
      refreshIndex: vi.fn(async () => {}),
    };
    const coordinator = new TurnContextCoordinator([new SkillContextContributor(new SkillCatalog([provider]))]);
    const session = await coordinator.beginTurn({ turnId: 'turn', attachmentPaths: [] });
    expect(session.initialEnvelope().skillCandidates?.map(skill => skill.id)).toEqual([descriptor.id]);
    expect(JSON.stringify(session.initialEnvelope())).not.toContain('SELECTED BODY');
    expect(capture).not.toHaveBeenCalled();
    const tools = new SkillToolRuntime(coordinator).tools;
    const activate = tools[0]!;
    const signal = new AbortController().signal;
    const output = JSON.parse(
      await activate.execute(JSON.stringify({ id: descriptor.id, reason: 'Relevant to this task' }), signal, {
        turnId: 'turn',
      }),
    ) as { instructionContext: AgentInstructionContext };
    expect(output.instructionContext).toHaveProperty('policy', expect.stringContaining('host and user policy'));
    expect(output.instructionContext.skills?.[0]?.body).toBe('SELECTED BODY');
    expect(JSON.stringify(output)).not.toContain('REFERENCE BODY');
    expect(await coordinator.activateSource('turn', 'skills', descriptor.id, 'model', 'Again')).toBeUndefined();
    const resource = JSON.parse(
      await tools[1]!.execute(JSON.stringify({ id: descriptor.id, path: 'references/example.md' }), signal, {
        turnId: 'turn',
      }),
    ) as { instructionContext: { skillResources: readonly SkillResourceUse[] } };
    expect(resource.instructionContext).toHaveProperty('policy', expect.stringContaining('host and user policy'));
    expect(resource.instructionContext.skillResources[0]).toMatchObject({
      content: 'REFERENCE BODY',
      encoding: 'utf8',
    });
    const binary = JSON.parse(
      await tools[1]!.execute(JSON.stringify({ id: descriptor.id, path: 'assets/image.bin' }), signal, {
        turnId: 'turn',
      }),
    ) as { instructionContext: { skillResources: readonly SkillResourceUse[] } };
    expect(binary.instructionContext.skillResources[0]).toMatchObject({ content: 'AP8A', encoding: 'base64' });
    expect(capture).toHaveBeenCalledOnce();
    const snapshot = coordinator.completeTurn('turn');
    expect(snapshot?.skills?.[0]).toMatchObject({
      reason: 'model',
      explanation: 'Relevant to this task',
      resources: [{ path: 'references/example.md' }, { path: 'assets/image.bin' }],
    });
    expect(coordinator.snapshot('turn')).toBeUndefined();
    expect(coordinator.contribution('turn', 'skills')).toBeUndefined();
  });

  it('allowlists model fields and keeps editor and installation provenance in the local snapshot', async () => {
    const descriptor = {
      ...aSkillDescriptor({ uri: 'file:///private/workspace', compatibility: 'Needs SDK', allowedTools: ['Read'] }),
      installation: { source: '/private/imported/package' },
    };
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: descriptor.origin,
        discover: async () => [descriptor],
        capture: async source => aSkillPackage(source),
        refreshIndex: async () => {},
      },
    ]);
    const session = await new SkillContextContributor(catalog).beginTurn({ turnId: 'projection', attachmentPaths: [] });
    const candidate = {
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description,
      scope: '.',
      origin: { scope: 'project', compatibility: 'glyph' },
    };
    expect(session.initialEnvelope().skillCandidates).toEqual([candidate]);
    const active = await session.activateSource(descriptor.id, 'model', 'Task');
    expect(active?.skills).toEqual([
      {
        descriptor: candidate,
        revision: expect.any(String),
        reason: 'model',
        explanation: 'Task',
        body: 'Skill instructions',
        compatibility: 'Needs SDK',
        allowedTools: ['Read'],
      },
    ]);
    expect(session.snapshot().skills?.[0]?.descriptor).toEqual(descriptor);
  });

  it('publishes steering selections together and leaves prior selections and advertisements intact on failure', async () => {
    const first = aSkillDescriptor();
    const other = aSkillDescriptor({ id: 'other' });
    const fresh = aSkillDescriptor({ id: 'fresh', name: 'fresh', scope: 'nested' });
    const broken = aSkillDescriptor({ id: 'broken', name: 'broken' });
    const capture = vi.fn(async (source: typeof first) => {
      if (source.id === 'broken') throw new Error('Changed during activation');
      return aSkillPackage(source);
    });
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: first.origin,
        discover: async () => [first, other, fresh, broken],
        capture,
        refreshIndex: async () => {},
      },
    ]);
    const session = await new SkillContextContributor(catalog).beginTurn({
      turnId: 'steering',
      skillIds: [first.id],
      attachmentPaths: [],
    });
    const steer = (skillIds: string[]) =>
      session.steer({ turnId: 'steering', skillIds, attachmentPaths: ['nested/file'] });
    await expect(steer([other.id])).rejects.toThrow('same-name');
    await expect(steer([fresh.id, 'missing'])).rejects.toThrow('unavailable');
    expect(capture).toHaveBeenCalledTimes(1);
    await expect(steer([fresh.id, broken.id])).rejects.toThrow('Changed during activation');
    expect(session.snapshot().skills?.map(skill => skill.descriptor.id)).toEqual([first.id]);
    expect(await session.activateSource(fresh.id, 'model', 'Not advertised')).toBeUndefined();
    const delta = await steer([first.id, fresh.id, fresh.id]);
    expect(delta?.skills?.map(skill => skill.descriptor.id)).toEqual([fresh.id]);
    expect(delta?.skillCandidates).toBeUndefined();
    expect(session.disclosePaths(['nested/another'])).toBeUndefined();
    expect(session.initialEnvelope().skills?.map(skill => skill.descriptor.id)).toEqual([first.id]);
    expect(await steer([fresh.id])).toBeUndefined();
    expect(await session.steer({ turnId: 'steering', attachmentPaths: [] })).toBeUndefined();
  });

  it('advertises nested candidates on file access and rejects unadvertised model choices', async () => {
    const source = aSkillDescriptor({ scope: 'packages/api' });
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: aSkillDescriptor().origin,
        discover: async () => [source],
        capture: async descriptor => aSkillPackage(descriptor),
        refreshIndex: async () => {},
      },
    ]);
    const coordinator = new TurnContextCoordinator([new SkillContextContributor(catalog)]);
    const session = await coordinator.beginTurn({ turnId: 'nested', attachmentPaths: [] });
    expect(session.initialEnvelope().skillCandidates).toBeUndefined();
    expect(await coordinator.activateSource('nested', 'skills', source.id, 'model', 'guess')).toBeUndefined();
    expect(await coordinator.disclosePaths('nested', ['packages/web/index.ts'])).toBeUndefined();
    expect((await coordinator.disclosePaths('nested', ['packages/api/index.ts']))?.skillCandidates?.[0]?.id).toBe(
      source.id,
    );
    expect(await coordinator.discloseAttachments('nested', ['packages/api/other.ts'])).toBeUndefined();
    expect(
      (await coordinator.activateSource('nested', 'skills', source.id, 'model', 'API task'))?.skills?.[0]?.body,
    ).toBe('Skill instructions');
  });

  it('deduplicates manual activation and freezes an active revision across catalog refresh', async () => {
    let body = 'FIRST BODY';
    const source = aSkillDescriptor();
    const capture = vi.fn(async () => aSkillPackage(source, body, { 'reference.md': Buffer.from(body) }));
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: aSkillDescriptor().origin,
        discover: async () => [source],
        capture,
        refreshIndex: async () => {},
      },
    ]);
    const coordinator = new TurnContextCoordinator([new SkillContextContributor(catalog)]);
    const first = await coordinator.beginTurn({
      turnId: 'first',
      attachmentPaths: [],
      skillIds: [source.id, source.id],
    });
    expect(first.initialEnvelope().skills?.[0]?.body).toBe('FIRST BODY');
    body = 'SECOND BODY';
    await catalog.refresh();
    const active = coordinator.contribution('first', 'skills');
    expect(active).toBeInstanceOf(SkillTurnContext);
    expect((await (active as SkillTurnContext).readResource(source.id, 'reference.md')).content).toBe('FIRST BODY');
    const second = await coordinator.beginTurn({ turnId: 'second', attachmentPaths: [], skillIds: [source.id] });
    expect(second.initialEnvelope().skills?.[0]?.body).toBe('SECOND BODY');
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('surfaces ambiguous same-name manual packages instead of choosing one silently', async () => {
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: aSkillDescriptor().origin,
        discover: async () => [aSkillDescriptor(), aSkillDescriptor({ id: 'other' })],
        capture: async descriptor => aSkillPackage(descriptor),
        refreshIndex: async () => {},
      },
    ]);
    await expect(
      new SkillContextContributor(catalog).beginTurn({
        turnId: 'ambiguous',
        attachmentPaths: [],
        skillIds: ['project:example', 'other'],
      }),
    ).rejects.toThrow('same-name');
  });

  it('shares failed duplicate captures and admits an unrelated concurrent selection afterwards', async () => {
    const source = aSkillDescriptor();
    const next = aSkillDescriptor({ id: 'next', name: 'next' });
    let fail!: (error: Error) => void;
    const capture = vi.fn(async (descriptor: typeof source) =>
      descriptor === source
        ? new Promise<ReturnType<typeof aSkillPackage>>((_resolve, reject) => {
            fail = reject;
          })
        : aSkillPackage(descriptor),
    );
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: source.origin,
        discover: async () => [source, next],
        capture,
        refreshIndex: async () => {},
      },
    ]);
    const session = new SkillTurnContext('turn', [source, next], [source, next], catalog);
    const first = session.activateSource(source.id, 'model', 'task');
    const duplicate = session.activateSource(source.id, 'model', 'task');
    const other = session.activateManualSkills([next.id], 'selected');
    fail(new Error('Read failed'));
    await expect(Promise.all([first, duplicate])).rejects.toThrow('Read failed');
    await expect(other).resolves.toMatchObject({ skills: [{ descriptor: { id: next.id } }] });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('rejects resource access before activation and prevents late activation after release', async () => {
    const source = aSkillDescriptor();
    let finish!: (value: ReturnType<typeof aSkillPackage>) => void;
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: aSkillDescriptor().origin,
        discover: async () => [source],
        capture: () =>
          new Promise(resolve => {
            finish = resolve;
          }),
        refreshIndex: async () => {},
      },
    ]);
    const session = new SkillTurnContext('turn', [source], [source], catalog);
    expect(() => session.readResource(source.id, 'reference.md')).toThrow('Activate');
    const activation = session.activateSource(source.id, 'model', 'Task');
    const duplicate = session.activateSource(source.id, 'model', 'Same task');
    session.release();
    finish(aSkillPackage(source));
    await expect(activation).rejects.toThrow('ended');
    await expect(duplicate).rejects.toThrow('ended');
    await expect(session.activateSource(source.id, 'manual', 'Task')).rejects.toThrow('ended');
    expect(() => session.readResource(source.id, 'reference.md')).toThrow('ended');
  });
});
