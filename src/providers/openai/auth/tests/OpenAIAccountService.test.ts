import { describe, expect, it, vi } from 'vitest';
import type { OpenAIAccountStore } from '#src/providers/openai/auth/OpenAIAccountStore.js';
import { OpenAIAccountService } from '#src/providers/openai/auth/OpenAIAccountService.js';

describe(OpenAIAccountService, () => {
  it('owns the exclusive store once while borrowed workspace stores cannot release it', async () => {
    const store = fixtureStore();
    const service = new OpenAIAccountService(store);
    await service.initialize();
    await service.initialize();
    const first = service.borrowStore();
    const second = service.borrowStore();
    await first.acquire();
    await first.load();
    await first.save();
    await first.release();
    await second.release();
    expect(store.acquire).toHaveBeenCalledTimes(1);
    expect(store.load).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.release).not.toHaveBeenCalled();
    await service.dispose();
    await service.dispose();
    expect(store.release).toHaveBeenCalledTimes(1);
    expect(() => service.borrowStore()).toThrowError(/not initialized/);
  });

  it('releases the lock when loading fails and reports cleanup failures', async () => {
    const store = fixtureStore();
    vi.mocked(store.load).mockRejectedValueOnce(new Error('load'));
    const service = new OpenAIAccountService(store);
    await expect(service.initialize()).rejects.toThrowError('load');
    expect(store.release).toHaveBeenCalledTimes(1);

    vi.mocked(store.load).mockRejectedValueOnce(new Error('load again'));
    vi.mocked(store.release).mockRejectedValueOnce(new Error('release'));
    await expect(service.initialize()).rejects.toBeInstanceOf(AggregateError);
  });
});

function fixtureStore(): OpenAIAccountStore {
  return {
    state: { version: 1, hostId: 'urn:uuid:test', accounts: [] },
    acquire: vi.fn(async () => {}),
    load: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
}
