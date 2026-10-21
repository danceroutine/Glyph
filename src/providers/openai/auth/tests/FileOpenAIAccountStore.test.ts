import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ConcurrentInstanceError } from '#src/errors/ConcurrentInstanceError.js';
import { PersistenceError } from '#src/errors/PersistenceError.js';
import { FileOpenAIAccountStore } from '#src/providers/openai/auth/FileOpenAIAccountStore.js';

vi.mock('node:fs/promises', { spy: true });

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

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

    it('is idempotent while the lock is held', async () => {
      const directory = await temporaryDirectory('glyph-auth-idempotent-');
      const store = new FileOpenAIAccountStore(directory);
      onTestFinished(() => store.release());
      await store.acquire();

      await expect(store.acquire()).resolves.toBeUndefined();
    });

    it('fails when the account directory cannot be prepared', async () => {
      const directory = await temporaryDirectory('glyph-auth-blocked-');
      await writeFile(join(directory, 'file'), '');

      await expect(new FileOpenAIAccountStore(join(directory, 'file', 'accounts')).acquire()).rejects.toThrow(
        new PersistenceError('Could not prepare the ChatGPT account directory.'),
      );
    });

    it('fails when the lock database cannot be opened', async () => {
      const directory = await temporaryDirectory('glyph-auth-lock-dir-');
      await mkdir(join(directory, 'session-lock.sqlite'));

      await expect(new FileOpenAIAccountStore(directory).acquire()).rejects.toThrow(
        new PersistenceError('Could not acquire the ChatGPT account lock.'),
      );
    });

    it('refuses to start while a live process owns the legacy lock', async () => {
      const directory = await temporaryDirectory('glyph-auth-legacy-live-');
      await mkdir(join(directory, 'session.lock'));
      await writeFile(join(directory, 'session.lock', 'pid'), '424242');
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      onTestFinished(() => kill.mockRestore());
      const store = new FileOpenAIAccountStore(directory);

      await expect(store.acquire()).rejects.toThrow(
        new ConcurrentInstanceError('Another Glyph instance owns the legacy account lock.'),
      );
      expect(kill).toHaveBeenCalledWith(424242, 0);
      await expect(lstat(join(directory, 'session.lock'))).resolves.toBeDefined();
    });

    it('refuses to start when the legacy lock owner cannot be checked', async () => {
      const directory = await temporaryDirectory('glyph-auth-legacy-eperm-');
      await mkdir(join(directory, 'session.lock'));
      await writeFile(join(directory, 'session.lock', 'pid'), '424242');
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
      });
      onTestFinished(() => kill.mockRestore());

      await expect(new FileOpenAIAccountStore(directory).acquire()).rejects.toThrow(
        new ConcurrentInstanceError('The legacy account-lock owner could not be checked.'),
      );
    });

    it.each(['not-a-pid', '0', '-5', '1.5'])('refuses to start when the legacy lock owner is %s', async pid => {
      const directory = await temporaryDirectory('glyph-auth-legacy-invalid-');
      await mkdir(join(directory, 'session.lock'));
      await writeFile(join(directory, 'session.lock', 'pid'), pid);

      await expect(new FileOpenAIAccountStore(directory).acquire()).rejects.toThrow(
        new ConcurrentInstanceError('A legacy account lock has an invalid owner.'),
      );
    });

    it('refuses to start when an incomplete legacy lock exists', async () => {
      const directory = await temporaryDirectory('glyph-auth-legacy-incomplete-');
      await mkdir(join(directory, 'session.lock'));

      await expect(new FileOpenAIAccountStore(directory).acquire()).rejects.toThrow(
        new ConcurrentInstanceError('A legacy account lock could not be verified.'),
      );
    });

    it('refuses to start when the legacy lock owner file is unreadable', async () => {
      const directory = await temporaryDirectory('glyph-auth-legacy-unreadable-');
      await mkdir(join(directory, 'session.lock', 'pid'), { recursive: true });

      await expect(new FileOpenAIAccountStore(directory).acquire()).rejects.toThrow(
        new ConcurrentInstanceError('A legacy account lock could not be verified.'),
      );
    });

    it('fails when the legacy lock cannot be inspected', async () => {
      const directory = await temporaryDirectory('glyph-auth-legacy-lstat-');
      vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));

      await expect(new FileOpenAIAccountStore(directory).acquire()).rejects.toThrow(
        new PersistenceError('Could not acquire the ChatGPT account lock.'),
      );
    });
  });

  describe(FileOpenAIAccountStore.prototype.load, () => {
    it('restores valid saved accounts', async () => {
      const directory = await temporaryDirectory('glyph-auth-load-');
      const saved = {
        version: 1,
        hostId: 'urn:uuid:saved-host',
        accounts: [
          { clientId: 'signed-out', subject: 'a', email: 'a@example.com' },
          {
            clientId: 'signed-in',
            subject: 'b',
            email: 'b@example.com',
            tokens: { accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAt: 1, scopes: ['plan'] },
          },
        ],
      };
      await writeFile(join(directory, 'accounts.json'), JSON.stringify(saved));
      const store = new FileOpenAIAccountStore(directory);

      await store.load();

      expect(store.state).toEqual(saved);
    });

    it.each<[string, unknown]>([
      ['null', null],
      ['a number', 5],
      ['another version', { version: 2, hostId: 'urn:uuid:host', accounts: [] }],
      ['a non-string host', { version: 1, hostId: 7, accounts: [] }],
      ['a host that is not a UUID URN', { version: 1, hostId: 'host', accounts: [] }],
      ['missing accounts', { version: 1, hostId: 'urn:uuid:host' }],
      [
        'an account without a client ID',
        { version: 1, hostId: 'urn:uuid:host', accounts: [{ subject: 's', email: 'e' }] },
      ],
      [
        'an unregistered dynamic client',
        {
          version: 1,
          hostId: 'urn:uuid:host',
          accounts: [{ clientId: 'dynamic_agent_client', subject: 's', email: 'e' }],
        },
      ],
      [
        'an account without a subject',
        { version: 1, hostId: 'urn:uuid:host', accounts: [{ clientId: 'c', email: 'e' }] },
      ],
      [
        'an account without an email',
        { version: 1, hostId: 'urn:uuid:host', accounts: [{ clientId: 'c', subject: 's' }] },
      ],
      ...[
        ['accessToken', { refreshToken: 'r', idToken: 'i', expiresAt: 1, scopes: [] }],
        ['refreshToken', { accessToken: 'a', idToken: 'i', expiresAt: 1, scopes: [] }],
        ['idToken', { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scopes: [] }],
        ['expiresAt', { accessToken: 'a', refreshToken: 'r', idToken: 'i', scopes: [] }],
        ['scopes', { accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAt: 1 }],
        ['string scopes', { accessToken: 'a', refreshToken: 'r', idToken: 'i', expiresAt: 1, scopes: [1] }],
      ].map(([field, tokens]): [string, unknown] => [
        `tokens with invalid ${String(field)}`,
        { version: 1, hostId: 'urn:uuid:host', accounts: [{ clientId: 'c', subject: 's', email: 'e', tokens }] },
      ]),
    ])('rejects a credential file containing %s', async (_case, contents) => {
      const directory = await temporaryDirectory('glyph-auth-invalid-');
      await writeFile(join(directory, 'accounts.json'), JSON.stringify(contents));

      await expect(new FileOpenAIAccountStore(directory).load()).rejects.toThrow(
        new PersistenceError('Credential file is invalid. Restore it or move it aside before restarting.'),
      );
    });

    it('rejects a credential file that is not JSON', async () => {
      const directory = await temporaryDirectory('glyph-auth-corrupt-');
      await writeFile(join(directory, 'accounts.json'), '{');

      await expect(new FileOpenAIAccountStore(directory).load()).rejects.toThrow(
        new PersistenceError('Could not load ChatGPT account state.'),
      );
    });

    it('rejects a credential path that cannot be read', async () => {
      const directory = await temporaryDirectory('glyph-auth-unreadable-');
      await mkdir(join(directory, 'accounts.json'));

      await expect(new FileOpenAIAccountStore(directory).load()).rejects.toThrow(
        new PersistenceError('Could not load ChatGPT account state.'),
      );
    });
  });

  describe(FileOpenAIAccountStore.prototype.save, () => {
    it('reports a failed write and lets a later save succeed', async () => {
      const directory = await temporaryDirectory('glyph-auth-save-');
      const store = new FileOpenAIAccountStore(join(directory, 'missing'));

      await expect(store.save()).rejects.toThrow(new PersistenceError('Could not persist ChatGPT account state.'));
      await mkdir(join(directory, 'missing'));
      await expect(store.save()).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(join(directory, 'missing', 'accounts.json'), 'utf8'))).toEqual(store.state);
    });
  });
});
