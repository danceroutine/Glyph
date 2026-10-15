import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConcurrentInstanceError } from '#src/errors/ConcurrentInstanceError.js';
import { FileOpenAIAccountStore } from '#src/providers/openai/auth/FileOpenAIAccountStore.js';

describe(FileOpenAIAccountStore, () => {
  describe(FileOpenAIAccountStore.prototype.acquire, () => {
    it('reclaims a crashed owner’s lock but still excludes a live replacement', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-crashed-account-lock-'));
      await mkdir(join(directory, 'session.lock'));
      await writeFile(join(directory, 'session.lock', 'pid'), '424242');
      const kill = vi.spyOn(process, 'kill').mockImplementation(pid => {
        if (pid === 424242) throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        return true;
      });
      const replacement = new FileOpenAIAccountStore(directory);
      try {
        await expect(replacement.acquire()).resolves.toBeUndefined();
        await expect(new FileOpenAIAccountStore(directory).acquire()).rejects.toBeInstanceOf(ConcurrentInstanceError);
      } finally {
        kill.mockRestore();
        await replacement.release();
        await rm(directory, { recursive: true, force: true });
      }
    });

    it('persists a stable host, restricts permissions, and excludes concurrent instances', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'glyph-auth-'));
      const store = new FileOpenAIAccountStore(directory);
      try {
        await store.acquire();
        await store.load();
        const other = new FileOpenAIAccountStore(directory);
        await expect(other.acquire()).rejects.toBeInstanceOf(ConcurrentInstanceError);
        await other.release();
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
