import { TurnContextSession } from '#src/context/turns/TurnContextSession.js';
import { InstructionContextContributor } from '#src/context/turns/InstructionContextContributor.js';
import { SkillContextContributor } from '#src/skills/SkillContextContributor.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';
import { aSkillDescriptor, aSkillPackage } from '#src/skills/tests/fixtures/aSkillDescriptor.js';
import { describe, expect, it, vi } from 'vitest';
import { InstructionPaths } from '#src/instructions/InstructionPaths.js';
import { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import {
  AgentInstructionActivationMode,
  AgentInstructionActivationReason,
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
  type AgentInstructionSource,
} from '#src/instructions/AgentInstructionSource.js';

const source = (
  id: string,
  kind: AgentInstructionSourceKind,
  scope: string,
  activation?: AgentInstructionActivationMode,
  globs?: readonly string[],
): AgentInstructionSource => ({
  id,
  kind,
  label: id,
  name: id,
  path: `${id}.mdc`,
  scope,
  status: AgentInstructionSourceStatus.ACTIVE,
  content: `${id} content`,
  revision: 'one',
  enabled: true,
  ...(activation ? { activation } : {}),
  ...(globs ? { globs } : {}),
  ...(activation === AgentInstructionActivationMode.MODEL ? { description: `${id} description` } : {}),
});

const sources = [
  source('root-agents', AgentInstructionSourceKind.AGENTS_MD, '.'),
  source('nested-agents', AgentInstructionSourceKind.AGENTS_MD, 'src'),
  source('always', AgentInstructionSourceKind.GLYPH_PROJECT_RULE, '.', AgentInstructionActivationMode.ALWAYS),
  source(
    'typescript',
    AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
    '.',
    AgentInstructionActivationMode.FILE_PATTERN,
    ['**/*.ts'],
  ),
  source('manual', AgentInstructionSourceKind.GLYPH_USER_RULE, '.', AgentInstructionActivationMode.MANUAL),
  source('model', AgentInstructionSourceKind.GLYPH_PROJECT_RULE, '.', AgentInstructionActivationMode.MODEL),
];

const catalog = () => ({ refresh: vi.fn(async () => sources) });

describe(TurnContextCoordinator, () => {
  it('supports manual activation through the instruction contribution port', () => {
    const rule = source(
      'manual-port',
      AgentInstructionSourceKind.GLYPH_USER_RULE,
      '.',
      AgentInstructionActivationMode.MANUAL,
    );
    const session = new TurnContextSession({
      turnId: 'manual-port',
      sources: [rule],
      manualRuleIds: [],
      attachmentPaths: [],
    });
    expect(
      session.activateRule(rule.id, AgentInstructionActivationReason.MANUAL)?.sources.map(value => value.id),
    ).toEqual([rule.id]);
  });

  it('prepares attachments, always-on sources, manual selections, and bounded candidates once', async () => {
    const coordinator = new TurnContextCoordinator(catalog() as never);
    const session = await coordinator.beginTurn({
      turnId: 'turn',
      attachmentPaths: ['src/app.ts', 'src/app.ts'],
      manualRuleIds: ['manual', 'manual'],
    });

    expect(session.initialEnvelope()).toMatchObject({
      sources: [
        { id: 'root-agents' },
        { id: 'nested-agents' },
        { id: 'always' },
        { id: 'typescript' },
        { id: 'manual' },
      ],
      candidates: [{ id: 'model', description: 'model description' }],
    });
    expect(session.snapshot().activations.map(activation => [activation.sourceId, activation.reason])).toEqual([
      ['root-agents', AgentInstructionActivationReason.ALWAYS],
      ['nested-agents', AgentInstructionActivationReason.ATTACHMENT],
      ['always', AgentInstructionActivationReason.ALWAYS],
      ['typescript', AgentInstructionActivationReason.ATTACHMENT],
      ['manual', AgentInstructionActivationReason.MANUAL],
    ]);
    expect(coordinator.disclosePaths('turn', ['src/app.ts'])).toBeUndefined();
  });

  it('discloses newly matching paths, activates model rules, and snapshots frozen revisions', async () => {
    const coordinator = new TurnContextCoordinator(catalog() as never);
    await coordinator.beginTurn({ turnId: 'turn', attachmentPaths: [] });

    expect(coordinator.disclosePaths('turn', ['src/app.ts'])).toMatchObject({
      sources: [{ id: 'nested-agents' }, { id: 'typescript' }],
    });
    expect(coordinator.activateRule('turn', 'model')).toMatchObject({ sources: [{ id: 'model' }] });
    expect(coordinator.activateRule('turn', 'model')).toBeUndefined();
    expect(coordinator.activateRule('turn', 'manual')).toBeUndefined();
    expect(coordinator.completeTurn('turn')).toMatchObject({
      schema: 'glyph.turn-context.v1',
      turnId: 'turn',
      sources: expect.arrayContaining([expect.objectContaining({ id: 'model', revision: 'one' })]),
    });
    expect(coordinator.snapshot('turn')).toBeUndefined();
  });

  it('starts with AGENTS.md from every attached workspace root and defers other scoped guidance', async () => {
    const paths = new InstructionPaths(
      new Map([
        ['Api', false],
        ['api', true],
      ]),
    );
    const discovered = [
      source('A', AgentInstructionSourceKind.AGENTS_MD, 'Api'),
      source('B', AgentInstructionSourceKind.AGENTS_MD, 'api'),
      source('nested', AgentInstructionSourceKind.AGENTS_MD, 'Api/src'),
      source('case-mismatch', AgentInstructionSourceKind.AGENTS_MD, 'API'),
      source('on-entry', AgentInstructionSourceKind.GLYPH_PROJECT_RULE, 'api', AgentInstructionActivationMode.ALWAYS),
    ];
    const coordinator = new TurnContextCoordinator(
      new AgentInstructionCatalog([{ discover: async () => discovered }], paths),
    );
    const turn = await coordinator.beginTurn({ turnId: 'roots', attachmentPaths: [] });
    expect(turn.initialEnvelope().sources.map(value => value.id)).toEqual(['A', 'B']);
    expect(turn.snapshot().activations.every(value => value.reason === AgentInstructionActivationReason.ALWAYS)).toBe(
      true,
    );
    expect(coordinator.disclosePaths('roots', ['Api/SRC/readme'])?.sources.map(value => value.id)).toEqual(['nested']);
    expect(coordinator.disclosePaths('roots', ['api/readme'])?.sources.map(value => value.id)).toEqual(['on-entry']);
  });

  it('evaluates global user patterns relative to the accessed root and bounds aggregate matching atomically', async () => {
    const paths = new InstructionPaths(
      new Map([
        ['api', false],
        ['web', true],
      ]),
    );
    const pattern = AgentInstructionActivationMode.FILE_PATTERN;
    const user = AgentInstructionSourceKind.GLYPH_USER_RULE;
    const rules = [
      source(
        'literal',
        user,
        '.',
        pattern,
        Array.from({ length: 64 }, () => 'src/entry.ts'),
      ),
      source('glob', user, '.', pattern, ['src/*.ts']),
      source(
        'heavy',
        user,
        '.',
        pattern,
        Array.from({ length: 64 }, (_, i) => 'a?'.repeat(190) + i + '*'),
      ),
    ];
    const coordinator = new TurnContextCoordinator(
      new AgentInstructionCatalog([{ discover: async () => rules }], paths),
    );
    const turn = await coordinator.beginTurn({ turnId: 'bounded', attachmentPaths: [] });
    expect(() => coordinator.disclosePaths('bounded', ['api/SRC/ENTRY.TS', 'web/' + 'a'.repeat(1000)])).toThrow(
      'per-disclosure work limit',
    );
    expect(turn.snapshot().activations).toEqual([]);
    expect(coordinator.disclosePaths('bounded', ['web/SRC/ENTRY.TS'])).toBeUndefined();
    expect(coordinator.disclosePaths('bounded', ['api/SRC/ENTRY.TS'])?.sources.map(value => value.id)).toEqual([
      'glob',
      'literal',
    ]);
  });

  it('identifies unreadable required guidance before starting a turn', async () => {
    const bad = {
      ...source('agents_md:AGENTS.md', AgentInstructionSourceKind.AGENTS_MD, '.'),
      path: 'AGENTS.md',
      status: AgentInstructionSourceStatus.ERROR,
    };
    for (const message of [undefined, 'Root exceeds the read limit.']) {
      const coordinator = new TurnContextCoordinator({ refresh: async () => [{ ...bad, message }] } as never);
      await expect(coordinator.beginTurn({ turnId: 'root', attachmentPaths: [] })).rejects.toThrow(
        'Required root instruction AGENTS.md could not be loaded',
      );
    }
  });

  it('activates scoped always, AGENTS.md and matching rules at the first case-aliased access', async () => {
    const paths = new InstructionPaths(
      new Map([
        ['Root', false],
        ['root', true],
      ]),
    );
    const discovered = [
      source(
        'always',
        AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
        'Root/Src',
        AgentInstructionActivationMode.ALWAYS,
      ),
      source('agents', AgentInstructionSourceKind.AGENTS_MD, 'Root/Src'),
      source(
        'files',
        AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
        'Root/Src',
        AgentInstructionActivationMode.FILE_PATTERN,
        ['**/*.TS'],
      ),
    ];
    const coordinator = new TurnContextCoordinator(
      new AgentInstructionCatalog([{ discover: async () => discovered }], paths),
    );
    await coordinator.beginTurn({ turnId: 'case', attachmentPaths: [] });
    expect(coordinator.disclosePaths('case', ['root/src/app.ts'])).toBeUndefined();
    expect(coordinator.disclosePaths('case', ['Root/src/app.ts'])?.sources.map(value => value.id)).toEqual([
      'always',
      'files',
      'agents',
    ]);
    expect(coordinator.discloseAttachments('case', ['Root/SRC/app.ts'])).toBeUndefined();
  });

  it('retains a user rule’s editor URI for inspection without sending it to the model', async () => {
    const rule = {
      ...source('user', AgentInstructionSourceKind.GLYPH_USER_RULE, '.', AgentInstructionActivationMode.ALWAYS),
      uri: 'file:///private/profile/rules/user.mdc',
    };
    const coordinator = new TurnContextCoordinator(new AgentInstructionCatalog([{ discover: async () => [rule] }]));
    const session = await coordinator.beginTurn({ turnId: 'uri', attachmentPaths: [] });
    expect(session.initialEnvelope().sources[0]).not.toHaveProperty('uri');
    expect(session.snapshot().sources[0]?.uri).toBe(rule.uri);
  });

  it('keeps over-budget disclosures out of history and demands the same guidance again on retry', async () => {
    const large = { ...source('big', AgentInstructionSourceKind.AGENTS_MD, 'large'), content: 'x'.repeat(512 * 1024) };
    const coordinator = new TurnContextCoordinator(new AgentInstructionCatalog([{ discover: async () => [large] }]));
    await coordinator.beginTurn({ turnId: 'budget', attachmentPaths: [] });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => coordinator.disclosePaths('budget', ['large/a'])).toThrow('512 KiB');
      expect(coordinator.snapshot('budget')?.sources).toEqual([]);
    }
    expect(coordinator.disclosePaths('budget', ['other/a'])).toBeUndefined();
  });

  it('reserves capacity before discovery and releases a failed admission', async () => {
    let release!: () => void;
    const discovery = new Promise<void>(resolve => {
      release = resolve;
    });
    const refresh = vi.fn(async () => {
      await discovery;
      return sources;
    });
    const coordinator = new TurnContextCoordinator({ refresh } as never);
    const starts = Array.from({ length: 32 }, (_, i) =>
      coordinator.beginTurn({ turnId: String(i), attachmentPaths: [] }),
    );
    await expect(coordinator.beginTurn({ turnId: '0', attachmentPaths: [] })).rejects.toThrow('already');
    await expect(coordinator.beginTurn({ turnId: 'extra', attachmentPaths: [] })).rejects.toThrow('32 turns');
    expect(refresh).toHaveBeenCalledTimes(32);
    release();
    await Promise.all(starts);
    coordinator.discardTurn('0');
    refresh.mockRejectedValueOnce(new Error('Discovery failed'));
    await expect(coordinator.beginTurn({ turnId: 'again', attachmentPaths: [] })).rejects.toThrow('Discovery failed');
    await expect(coordinator.beginTurn({ turnId: 'again', attachmentPaths: [] })).resolves.toBeDefined();
  });

  it('isolates and bounds live sessions', async () => {
    const coordinator = new TurnContextCoordinator(catalog() as never);
    for (let index = 0; index < 32; index++)
      await coordinator.beginTurn({ turnId: `turn-${index}`, attachmentPaths: [] });

    await expect(coordinator.beginTurn({ turnId: 'turn-32', attachmentPaths: [] })).rejects.toThrow('32 turns');
    await expect(coordinator.beginTurn({ turnId: 'turn-0', attachmentPaths: [] })).rejects.toThrow('already');
    expect(coordinator.snapshot('turn-0')?.turnId).toBe('turn-0');
    coordinator.completeTurn('turn-0');
    await coordinator.beginTurn({ turnId: 'turn-32', attachmentPaths: [] });
    expect(coordinator.snapshot('turn-32')?.turnId).toBe('turn-32');
    expect(coordinator.disclosePaths('missing', ['src/app.ts'])).toBeUndefined();
  });

  it('advertises and activates rules only for participating multi-root paths', async () => {
    const apiModel = source(
      'api-model',
      AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      'api',
      AgentInstructionActivationMode.MODEL,
    );
    const webModel = source(
      'web-model',
      AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      'web',
      AgentInstructionActivationMode.MODEL,
    );
    const coordinator = new TurnContextCoordinator({ refresh: vi.fn(async () => [apiModel, webModel]) } as never);
    const session = await coordinator.beginTurn({ turnId: 'roots', attachmentPaths: ['api/src/app.ts'] });

    expect(session.initialEnvelope().candidates?.map(candidate => candidate.id)).toEqual(['api-model']);
    expect(coordinator.activateRule('roots', 'web-model')).toBeUndefined();
    expect(coordinator.disclosePaths('roots', ['web/src/app.ts'])?.candidates?.map(candidate => candidate.id)).toEqual([
      'web-model',
    ]);
    expect(coordinator.activateRule('roots', 'web-model')?.sources.map(value => value.id)).toEqual(['web-model']);
  });

  it('handles steering attachments, manual activation, empty turns, and explicit disposal', async () => {
    const coordinator = new TurnContextCoordinator(catalog() as never);
    await coordinator.beginTurn({ turnId: 'steering', attachmentPaths: [] });

    expect(coordinator.discloseAttachments('steering', ['src/app.ts'])?.sources.map(value => value.id)).toEqual([
      'nested-agents',
      'typescript',
    ]);
    expect(coordinator.activateManualRules('steering', ['manual'])?.sources.map(value => value.id)).toEqual(['manual']);
    expect(coordinator.activateManualRules('steering', ['manual'])).toBeUndefined();
    coordinator.discardTurn('steering');
    expect(coordinator.discloseAttachments('steering', ['src/app.ts'])).toBeUndefined();
    expect(coordinator.activateManualRules('steering', ['manual'])).toBeUndefined();

    const empty = new TurnContextCoordinator({ refresh: vi.fn(async () => []) } as never);
    expect((await empty.beginTurn({ turnId: 'empty', attachmentPaths: [] })).initialEnvelope()).toEqual({
      schema: 'glyph.agent-instructions.v1',
      sources: [],
    });
  });

  it('rejects unavailable explicit selections and omits missing or ineligible model candidates', async () => {
    const disabled = {
      ...source('disabled', AgentInstructionSourceKind.GLYPH_USER_RULE, '.', AgentInstructionActivationMode.MANUAL),
      enabled: false,
    };
    const failed = {
      ...source('failed', AgentInstructionSourceKind.GLYPH_PROJECT_RULE, '.', AgentInstructionActivationMode.ALWAYS),
      status: AgentInstructionSourceStatus.ERROR,
    };
    const unnamedModel = {
      ...source('unnamed', AgentInstructionSourceKind.GLYPH_PROJECT_RULE, '.', AgentInstructionActivationMode.MODEL),
      name: undefined,
    };
    const coordinator = new TurnContextCoordinator({
      refresh: vi.fn(async () => [disabled, failed, unnamedModel]),
    } as never);
    const session = await coordinator.beginTurn({ turnId: 'ineligible', attachmentPaths: [] });

    expect(session.initialEnvelope().candidates).toEqual([expect.objectContaining({ id: 'unnamed', name: 'unnamed' })]);
    expect(() => coordinator.activateManualRules('ineligible', ['disabled', 'missing'])).toThrow('manual activation');
    expect(() => coordinator.activateManualRules('ineligible', ['missing'])).toThrow('unavailable');
    expect(coordinator.activateRule('ineligible', 'disabled')).toBeUndefined();
    expect(() => coordinator.activateManualRules('ineligible', ['unnamed'])).toThrow('manual activation');
    await expect(
      coordinator.beginTurn({ turnId: 'queued', attachmentPaths: [], manualRuleIds: ['unnamed'] }),
    ).rejects.toThrow('manual activation');
    expect(() => coordinator.activateManualRules('ineligible', ['missing'])).toThrow('unavailable');
  });
});

it('restores every domain after a steering disclosure exceeds the remaining instruction budget', async () => {
  const nested = {
    ...source('nested', AgentInstructionSourceKind.AGENTS_MD, 'src'),
    content: 'n'.repeat(280 * 1024),
  };
  const manual = {
    ...source(
      'manual-large',
      AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      '.',
      AgentInstructionActivationMode.MANUAL,
    ),
    content: 'm'.repeat(280 * 1024),
  };
  const selected = aSkillDescriptor();
  const nestedSkill = aSkillDescriptor({ id: 'nested-skill', name: 'nested-skill', scope: 'src' });
  const skills = new SkillCatalog([
    {
      id: selected.origin.id,
      origin: selected.origin,
      discover: async () => [selected, nestedSkill],
      capture: async descriptor => aSkillPackage(descriptor),
      refreshIndex: async () => {},
    },
  ]);
  const turns = new TurnContextCoordinator([
    new InstructionContextContributor(new AgentInstructionCatalog([{ discover: async () => [nested, manual] }])),
    new SkillContextContributor(skills),
  ]);
  const input = { turnId: 'steer', attachmentPaths: ['src/app.ts'], skillIds: [selected.id] };
  const session = await turns.beginTurn({ turnId: input.turnId, attachmentPaths: [] });
  const prior = session.snapshot();
  await expect(turns.steer({ ...input, manualRuleIds: [manual.id] })).rejects.toThrow('512 KiB');
  expect(session.snapshot()).toEqual(prior);
  const accepted = await turns.steer(input);
  expect(accepted?.skills?.[0]?.body).toBe('Skill instructions');
  expect(accepted?.skillCandidates?.map(skill => skill.id)).toEqual([nestedSkill.id]);
  expect(accepted?.sources.map(rule => rule.id)).toEqual([nested.id]);
});

it('admits manual instructions through the direct turn session and through coordinated steering', async () => {
  const input = { turnId: 'direct', attachmentPaths: [], manualRuleIds: [] };
  const session = new TurnContextSession({ ...input, sources });
  expect(session.activateRule('manual', AgentInstructionActivationReason.MANUAL)?.sources[0]?.id).toBe('manual');
  const coordinator = new TurnContextCoordinator(catalog() as never);
  expect(await coordinator.steer(input)).toBeUndefined();
  await coordinator.beginTurn(input);
  expect((await coordinator.steer({ ...input, manualRuleIds: ['manual'] }))?.sources[0]?.id).toBe('manual');
});
