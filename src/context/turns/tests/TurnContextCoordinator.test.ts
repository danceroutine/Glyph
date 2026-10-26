import { describe, expect, it, vi } from 'vitest';
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

  it('isolates and bounds live sessions', async () => {
    const coordinator = new TurnContextCoordinator(catalog() as never);
    for (let index = 0; index < 33; index++)
      await coordinator.beginTurn({ turnId: `turn-${index}`, attachmentPaths: [] });

    expect(coordinator.snapshot('turn-0')).toBeUndefined();
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

  it('ignores disabled, failed, ineligible, and unknown selections', async () => {
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
    expect(coordinator.activateManualRules('ineligible', ['disabled', 'missing'])).toBeUndefined();
    expect(coordinator.activateRule('ineligible', 'disabled')).toBeUndefined();
    expect(session.activateRule('unnamed', AgentInstructionActivationReason.MANUAL)).toBeUndefined();
  });
});
