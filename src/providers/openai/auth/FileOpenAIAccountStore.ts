import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ConcurrentInstanceError } from '#src/errors/ConcurrentInstanceError.js';
import { PersistenceError } from '#src/errors/PersistenceError.js';
import type { OpenAIAccountStore } from './OpenAIAccountStore.ts';
import type { OpenAISavedState } from './OpenAISavedState.ts';
import { errorCodeOf } from '#src/shared/mappers/errorCodeOf.js';
import { isRecord } from '#src/shared/validators/isRecord.js';

export class FileOpenAIAccountStore implements OpenAIAccountStore {
  private saving: Promise<void> = Promise.resolve();
  private lock: Database.Database | undefined;
  readonly state: OpenAISavedState = {
    version: 1,
    hostId: `urn:uuid:${randomUUID()}`,
    accounts: [],
  };

  constructor(readonly directory: string) {}

  async acquire(): Promise<void> {
    if (this.lock) return;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
    } catch (error) {
      throw new PersistenceError('Could not prepare the ChatGPT account directory.', { cause: error });
    }
    let lock: Database.Database | undefined;
    try {
      // SQLite's OS lock dies with the process, unlike a sentinel directory.
      // Keep this transaction open for the store's lifetime; credentials remain
      // in accounts.json and concurrent application instances still fail closed.
      lock = new Database(join(this.directory, 'session-lock.sqlite'), { timeout: 0 });
      lock.exec('BEGIN EXCLUSIVE');
      await chmod(join(this.directory, 'session-lock.sqlite'), 0o600);
      await this.retireLegacyLock();
      this.lock = lock;
    } catch (error) {
      lock?.close();
      if (error instanceof ConcurrentInstanceError) throw error;
      if (errorCodeOf(error) === 'SQLITE_BUSY')
        throw new ConcurrentInstanceError('Another Glyph instance owns this account store.', { cause: error });
      throw new PersistenceError('Could not acquire the ChatGPT account lock.', { cause: error });
    }
  }

  async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.directory, 'accounts.json'), 'utf8'));
      if (!isOpenAISavedState(raw)) {
        throw new PersistenceError('Credential file is invalid. Restore it or move it aside before restarting.');
      }
      Object.assign(this.state, raw);
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') {
        await this.save();
        return;
      }
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('Could not load ChatGPT account state.', { cause: error });
    }
  }

  save(): Promise<void> {
    // Atomic rename prevents torn files, not stale writers. Serialize the whole
    // capture/write/rename transaction and allow a later save to retry failures.
    const saving = this.saving.then(() => this.persist());
    this.saving = saving.catch(() => {});
    return saving;
  }

  async release(): Promise<void> {
    await this.saving;
    this.lock?.close();
    this.lock = undefined;
  }

  /** Only retire old-version sentinel locks when their recorded process is conclusively dead. */
  private async retireLegacyLock(): Promise<void> {
    const path = join(this.directory, 'session.lock');
    let pid: number;
    try {
      pid = Number(await readFile(join(path, 'pid'), 'utf8'));
    } catch (error) {
      if (errorCodeOf(error) === 'ENOENT') {
        // Distinguish no legacy lock from an incomplete, unverifiable one.
        try {
          await lstat(path);
        } catch (missing) {
          if (errorCodeOf(missing) === 'ENOENT') return;
          throw missing;
        }
      }
      throw new ConcurrentInstanceError('A legacy account lock could not be verified.', { cause: error });
    }
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new ConcurrentInstanceError('A legacy account lock has an invalid owner.');
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (errorCodeOf(error) === 'ESRCH') {
        await rm(path, { recursive: true, force: true });
        return;
      }
      throw new ConcurrentInstanceError('The legacy account-lock owner could not be checked.', { cause: error });
    }
    throw new ConcurrentInstanceError('Another Glyph instance owns the legacy account lock.');
  }

  private async persist(): Promise<void> {
    const temporary = join(this.directory, `accounts.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(this.state, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, 'accounts.json'));
    } catch (error) {
      throw new PersistenceError('Could not persist ChatGPT account state.', { cause: error });
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function isOpenAISavedState(raw: unknown): raw is OpenAISavedState {
  if (!isRecord(raw)) return false;
  const { version, hostId, accounts } = raw;
  if (version !== 1 || typeof hostId !== 'string' || !hostId.startsWith('urn:uuid:') || !Array.isArray(accounts))
    return false;
  const entries: unknown[] = accounts;
  return entries.every(
    account =>
      isRecord(account) &&
      typeof account.clientId === 'string' &&
      account.clientId !== 'dynamic_agent_client' &&
      typeof account.subject === 'string' &&
      typeof account.email === 'string' &&
      (account.tokens === undefined || account.tokens === null || isSavedTokens(account.tokens)),
  );
}

function isSavedTokens(tokens: unknown): boolean {
  if (!isRecord(tokens) || !Array.isArray(tokens.scopes)) return false;
  const scopes: unknown[] = tokens.scopes;
  return (
    typeof tokens.accessToken === 'string' &&
    typeof tokens.refreshToken === 'string' &&
    typeof tokens.idToken === 'string' &&
    Number.isFinite(tokens.expiresAt) &&
    scopes.every(scope => typeof scope === 'string')
  );
}
