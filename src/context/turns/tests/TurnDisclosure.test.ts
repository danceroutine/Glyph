import { describe, expect, it, vi } from 'vitest';
import { TurnContextCoordinator } from '../TurnContextCoordinator.ts';
import { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import {
  AgentInstructionActivationMode,
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
} from '#src/instructions/AgentInstructionSource.js';
import { sourceReads } from '#src/workspace/SourceDisclosure.js';
import type { PinnedSource } from '#src/workspace/PinnedSourceAuthority.js';

function fixture() {
  const paths = ['/project/rule.mdc', '/project/reference.md'];
  const files = paths.map(path => ({ path, origin: path, identity: '1:1' }));
  const denied = new Set<string>();
  const capture = vi.fn(async (selected: readonly string[]) =>
    selected.map(path => ({ ...files.find(pin => pin.path === path)! })),
  );
  const authorize = vi.fn(async (pins: readonly PinnedSource[]) => () => {
    if (
      pins.some(
        ({ path, origin }) => denied.has(path) || !files.some(file => file.path === path && file.origin === origin),
      )
    )
      throw Error('Source unavailable');
  });
  const source = {
    id: 'rule',
    path: 'rule.mdc',
    scope: '.',
    label: 'rule',
    description: 'candidate',
    content: 'original reference',
    kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
    status: AgentInstructionSourceStatus.ACTIVE,
    activation: AgentInstructionActivationMode.MODEL,
    [sourceReads]: {
      authority: { capture, authorize },
      files: paths.map(path => ({ uri: 'file://' + path, identity: '1:1' })),
    },
  };
  const catalog = new AgentInstructionCatalog([{ discover: async () => [source] }]);
  return { coordinator: new TurnContextCoordinator(catalog), capture, authorize, denied, paths, files, source };
}

describe(TurnContextCoordinator, () => {
  it('checks metadata independently and admits original bytes only while every contributing route remains authorized', async () => {
    const { coordinator, capture, authorize, denied, paths, files } = fixture();
    denied.add(paths[1]!);
    const session = await coordinator.beginTurn({ turnId: 't', attachmentPaths: [] });
    expect(capture.mock.calls).toEqual([[paths, undefined]]);
    expect(session.initialEnvelope().candidates?.[0]?.id).toBe('rule');
    expect(authorize.mock.calls[0]![0].map(pin => pin.path)).toEqual([paths[0]]);
    await expect(coordinator.activateRule('t', 'rule')).rejects.toThrow('Source unavailable');
    expect(session.snapshot().sources).toEqual([]);
    denied.clear();
    files[1]!.identity = '1:2';
    const results = await Promise.all([coordinator.activateRule('t', 'rule'), coordinator.activateRule('t', 'rule')]);
    expect(results[0]?.sources[0]?.content).toBe('original reference');
    expect(results[1]).toBeUndefined();
    expect(Object.getOwnPropertySymbols(results[0]!.sources[0]!)).toEqual([]);
    expect(Object.getOwnPropertySymbols(session.snapshot().sources[0]!)).toEqual([]);
    const guard = await coordinator.authorizeDisclosure('t');
    guard();
    denied.add(paths[0]!);
    expect(guard).toThrow('Source unavailable');
    denied.clear();
    files[1]!.origin = 'different directory';
    await expect(coordinator.authorizeDisclosure('t')).rejects.toThrow('Source unavailable');
    coordinator.discardTurn('t');
    expect(() => coordinator.authorizeDisclosure('t')).toThrow('ended');
  });

  it('rejects a changed read identity before admitting the turn', async () => {
    const { coordinator, files } = fixture();
    files[0]!.identity = '1:2';
    await expect(coordinator.beginTurn({ turnId: 't', attachmentPaths: [] })).rejects.toThrow(
      'changed during discovery',
    );
    expect(coordinator.snapshot('t')).toBeUndefined();
  });
});
