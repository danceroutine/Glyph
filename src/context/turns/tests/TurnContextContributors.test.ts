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
  it('releases replaced turns and evicted sessions, keeping domains optional', async () => {
    const release = vi.fn();
    const coordinator = new TurnContextCoordinator([
      { id: 'empty', beginTurn: async input => ({ ...aContribution(input.turnId), release }) },
    ]);
    await coordinator.beginTurn({ turnId: 'same', attachmentPaths: [] });
    await coordinator.beginTurn({ turnId: 'same', attachmentPaths: [] });
    expect(release).toHaveBeenCalledOnce();
    for (let i = 0; i < 33; i++) await coordinator.beginTurn({ turnId: `turn-${i}`, attachmentPaths: [] });
    expect(coordinator.snapshot('same')).toBeUndefined();
    expect(coordinator.snapshot('turn-0')).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(3);
    expect(coordinator.activateRule('turn-32', 'missing')).toBeUndefined();
    expect(await coordinator.activateSource('turn-32', 'empty', 'missing', 'manual', 'Selected')).toBeUndefined();
  });
});
