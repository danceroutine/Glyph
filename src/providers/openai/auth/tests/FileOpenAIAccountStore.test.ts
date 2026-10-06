import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConcurrentInstanceError } from '../../../../errors/ConcurrentInstanceError.ts';
import { FileOpenAIAccountStore } from '../FileOpenAIAccountStore.ts';

describe(FileOpenAIAccountStore, () => {
  describe(FileOpenAIAccountStore.prototype.acquire, () => {
    it('persists a stable host, restricts permissions, and excludes concurrent instances', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-auth-'));
      const store = new FileOpenAIAccountStore(directory);
      try {
        await store.acquire();
        await store.load();
        const other = new FileOpenAIAccountStore(directory);
        await expect(other.acquire()).rejects.toBeInstanceOf(ConcurrentInstanceError);
        await other.load();
        expect(other.state.hostId).toBe(store.state.hostId);
        if (process.platform !== 'win32') {
          expect((await stat(join(directory, 'accounts.json'))).mode & 0o777).toBe(0o600);
        }
        await store.release();
        await other.acquire();
        await other.release();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});
