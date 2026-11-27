import { describe, expect, it, vi } from 'vitest';
import { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import type { TurnContextContribution, TurnContextContributor } from '#src/context/turns/TurnContextContributor.js';

function aContribution(turnId: string): TurnContextContribution {
  return {
    initialEnvelope: () => ({ schema: 'glyph.agent-instructions.v1', sources: [] }),
    snapshot: () => ({ schema: 'glyph.turn-context.v1', turnId, sources: [], candidates: [], activations: [] }),
    release: vi.fn(),
  };
}

describe('Turn context contributor lifetime', () => {
  it('rejects ambiguous contributor IDs', () => {
    const contributor: TurnContextContributor = { id: 'same', beginTurn: async input => aContribution(input.turnId) };
    expect(() => new TurnContextCoordinator([contributor, contributor])).toThrow('unique');
  });
  it.each(['failure', 'cancellation'])('releases prepared contributions after %s', async scenario => {
    const prepared = aContribution('turn');
    const controller = new AbortController();
    const first: TurnContextContributor = {
      id: 'first',
      beginTurn: async () => {
        if (scenario === 'cancellation') controller.abort(new Error('Cancelled'));
        return prepared;
      },
    };
    const second: TurnContextContributor = {
      id: 'second',
      beginTurn: async () => {
        throw new Error('Discovery failed');
      },
    };
    const coordinator = new TurnContextCoordinator([first, second]);
    await expect(coordinator.beginTurn({ turnId: 'turn', attachmentPaths: [] }, controller.signal)).rejects.toThrow(
      scenario === 'failure' ? 'Discovery failed' : 'Cancelled',
    );
    expect(prepared.release).toHaveBeenCalledOnce();
    expect(coordinator.snapshot('turn')).toBeUndefined();
  });
  it('retains admitted sessions and rejects duplicate or excess admissions', async () => {
    const release = vi.fn();
    const coordinator = new TurnContextCoordinator([
      { id: 'empty', beginTurn: async input => ({ ...aContribution(input.turnId), release }) },
    ]);
    await coordinator.beginTurn({ turnId: 'same', attachmentPaths: [] });
    await expect(coordinator.beginTurn({ turnId: 'same', attachmentPaths: [] })).rejects.toThrow('already');
    for (let i = 0; i < 31; i++) await coordinator.beginTurn({ turnId: `turn-${i}`, attachmentPaths: [] });
    await expect(coordinator.beginTurn({ turnId: 'excess', attachmentPaths: [] })).rejects.toThrow('32 turns');
    expect(coordinator.snapshot('same')).toBeDefined();
    expect(coordinator.snapshot('turn-0')).toBeDefined();
    expect(release).not.toHaveBeenCalled();
    coordinator.discardTurn('same');
    await coordinator.beginTurn({ turnId: 'replacement', attachmentPaths: [] });
    expect(release).toHaveBeenCalledOnce();
    expect(await coordinator.activateRule('replacement', 'missing')).toBeUndefined();
    expect(await coordinator.activateSource('replacement', 'empty', 'missing', 'manual', 'Selected')).toBeUndefined();
  });
});

it('steers contributors that do not provide a checkpoint', async () => {
  const coordinator = new TurnContextCoordinator([{ id: 'fixture', beginTurn: async () => aContribution('turn') }]);
  await coordinator.beginTurn({ turnId: 'turn', attachmentPaths: [] });
  expect(await coordinator.steer({ turnId: 'turn', attachmentPaths: [] })).toBeUndefined();
});
