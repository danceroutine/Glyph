import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
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

  it('fits optional advertisements around required sources and activates only the offered candidates', async () => {
    const model = (id: string, size: number) => ({
      ...source(id, AgentInstructionSourceKind.GLYPH_PROJECT_RULE, '.', AgentInstructionActivationMode.MODEL),
      description: 'x'.repeat(size),
    });
    const many = Array.from({ length: 255 }, (_, index) => model('large-' + index, 2000));
    const start = async (id: string, list: AgentInstructionSource[]) => {
      const coordinator = new TurnContextCoordinator({ refresh: async () => list } as never);
      const turn = await coordinator.beginTurn({ turnId: id, attachmentPaths: [] });
      return { turn, coordinator };
    };
    const mandatory = { ...sources[0]!, content: 'a'.repeat(510 * 1024) };
    const { turn, coordinator } = await start('bytes', [mandatory, ...many, model('small', 8)]);
    const initial = turn.initialEnvelope();
    expect(initial.sources).toMatchObject([{ id: mandatory.id }]);
    expect(initial.candidates?.map(candidate => candidate.id)).toEqual(['small']);
    expect(coordinator.activateRule('bytes', 'large-0')).toBeUndefined();
    expect(coordinator.disclosePaths('bytes', ['file'])).toBeUndefined();
    expect(coordinator.activateRule('bytes', 'small')?.sources[0]?.id).toBe('small');
    const bounded = await start('advertised-bytes', many);
    expect(Buffer.byteLength(JSON.stringify(bounded.turn.initialEnvelope().candidates))).toBeLessThanOrEqual(32 * 1024);
    expect(bounded.turn.initialEnvelope().candidates?.length).toBeGreaterThan(0);
    const count = await start(
      'count',
      Array.from({ length: 65 }, (_, index) => model(String(index), 1)),
    );
    expect(count.turn.initialEnvelope().candidates).toHaveLength(50);
    expect(count.coordinator.disclosePaths('count', ['file'])).toBeUndefined();
  });

  it('selects nested guidance and literal globs for the name policy of each attached volume', async () => {
    const composed = 'café';
    const decomposed = composed.normalize('NFD');
    for (const normalizesUnicode of [false, true]) {
      const paths = new InstructionPaths(
        true,
        new WorkspaceSourceRoutes([{ name: 'project', path: '/root', normalizesUnicode }]),
      );
      const list = [
        source('nested', AgentInstructionSourceKind.AGENTS_MD, composed),
        source(
          'glob',
          AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
          '.',
          AgentInstructionActivationMode.FILE_PATTERN,
          [composed + '/**/*.txt'],
        ),
      ];
      const coordinator = new TurnContextCoordinator(
        new AgentInstructionCatalog([{ discover: async () => list }], paths),
      );
      const turn = await coordinator.beginTurn({ turnId: 'unicode', attachmentPaths: [decomposed + '/file.txt'] });
      expect(
        turn
          .initialEnvelope()
          .sources.map(item => item.id)
          .sort(),
      ).toEqual(normalizesUnicode ? ['glob', 'nested'] : []);
      expect(coordinator.disclosePaths('unicode', [composed + '/file.txt'])?.sources.length).toBe(
        normalizesUnicode ? undefined : 2,
      );
    }
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
    expect(() => turn.disclosePaths(['api/SRC/ENTRY.TS', 'web/' + 'a'.repeat(1000)])).toThrow(
      'per-disclosure work limit',
    );
    expect(turn.snapshot().activations).toEqual([]);
    expect(turn.disclosePaths(['web/SRC/ENTRY.TS'])).toBeUndefined();
    expect(turn.disclosePaths(['api/SRC/ENTRY.TS'])?.sources.map(value => value.id)).toEqual(['glob', 'literal']);
  });

  it('blocks only attachments, reads and mutations below an unreadable guidance source', async () => {
    const sourcePath = 'src/AGENTS.md';
    for (const message of [undefined, 'Too large']) {
      const bad = {
        ...source('unreadable', AgentInstructionSourceKind.AGENTS_MD, 'src'),
        path: sourcePath,
        status: AgentInstructionSourceStatus.ERROR,
        ...(message ? { message } : {}),
      };
      const root = source('root', AgentInstructionSourceKind.AGENTS_MD, '.');
      const coordinator = new TurnContextCoordinator(
        new AgentInstructionCatalog([{ discover: async () => [root, bad] }]),
      );
      await expect(coordinator.beginTurn({ turnId: 'attached', attachmentPaths: ['src/file'] })).rejects.toThrow(
        sourcePath,
      );
      const turn = await coordinator.beginTurn({ turnId: 'turn', attachmentPaths: ['src-other/file'] });
      expect(turn.initialEnvelope().sources).toHaveLength(1);
      expect(() => coordinator.discloseAttachments('turn', ['src/test'])).toThrow(sourcePath);
      expect(() => coordinator.disclosePaths('turn', ['src/file'])).toThrow(sourcePath);
      expect(coordinator.disclosePaths('turn', ['docs/file'])).toBeUndefined();
    }
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
    expect(() => session.activateRule('unnamed', AgentInstructionActivationReason.MANUAL)).toThrow('manual activation');
    await expect(
      coordinator.beginTurn({ turnId: 'queued', attachmentPaths: [], manualRuleIds: ['unnamed'] }),
    ).rejects.toThrow('manual activation');
    expect(() => session.activateRule('missing', AgentInstructionActivationReason.MANUAL)).toThrow('unavailable');
  });
});
