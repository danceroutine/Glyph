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
    expect(output.instructionContext.skills?.[0]?.body).toBe('SELECTED BODY');
    expect(JSON.stringify(output)).not.toContain('REFERENCE BODY');
    expect(await coordinator.activateSource('turn', 'skills', descriptor.id, 'model', 'Again')).toBeUndefined();
    const resource = JSON.parse(
      await tools[1]!.execute(JSON.stringify({ id: descriptor.id, path: 'references/example.md' }), signal, {
        turnId: 'turn',
      }),
    ) as { instructionContext: { skillResources: readonly SkillResourceUse[] } };
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

  it('advertises nested candidates on file access and rejects unadvertised model choices', async () => {
    const source = aSkillDescriptor({ scope: 'packages/api' });
    const catalog = new SkillCatalog([
      {
        id: 'project',
        discover: async () => [source],
        capture: async descriptor => aSkillPackage(descriptor),
        refreshIndex: async () => {},
      },
    ]);
    const coordinator = new TurnContextCoordinator([new SkillContextContributor(catalog)]);
    const session = await coordinator.beginTurn({ turnId: 'nested', attachmentPaths: [] });
    expect(session.initialEnvelope().skillCandidates).toBeUndefined();
    expect(await coordinator.activateSource('nested', 'skills', source.id, 'model', 'guess')).toBeUndefined();
    expect(coordinator.disclosePaths('nested', ['packages/web/index.ts'])).toBeUndefined();
    expect(coordinator.disclosePaths('nested', ['packages/api/index.ts'])?.skillCandidates?.[0]?.id).toBe(source.id);
    expect(coordinator.discloseAttachments('nested', ['packages/api/other.ts'])).toBeUndefined();
    expect(
      (await coordinator.activateSource('nested', 'skills', source.id, 'model', 'API task'))?.skills?.[0]?.body,
    ).toBe('Skill instructions');
  });

  it('deduplicates manual activation and freezes an active revision across catalog refresh', async () => {
    let body = 'FIRST BODY';
    const source = aSkillDescriptor();
    const capture = vi.fn(async () => aSkillPackage(source, body, { 'reference.md': Buffer.from(body) }));
    const catalog = new SkillCatalog([
      { id: 'project', discover: async () => [source], capture, refreshIndex: async () => {} },
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
    expect((active as SkillTurnContext).readResource(source.id, 'reference.md').content).toBe('FIRST BODY');
    const second = await coordinator.beginTurn({ turnId: 'second', attachmentPaths: [], skillIds: [source.id] });
    expect(second.initialEnvelope().skills?.[0]?.body).toBe('SECOND BODY');
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('surfaces ambiguous same-name manual packages instead of choosing one silently', async () => {
    const catalog = new SkillCatalog([
      {
        id: 'project',
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

  it('rejects resource access before activation and prevents late activation after release', async () => {
    const source = aSkillDescriptor();
    let finish!: (value: ReturnType<typeof aSkillPackage>) => void;
    const catalog = new SkillCatalog([
      {
        id: 'project',
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
