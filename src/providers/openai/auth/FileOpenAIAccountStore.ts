import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConcurrentInstanceError } from '../../../errors/ConcurrentInstanceError.ts';
import { PersistenceError } from '../../../errors/PersistenceError.ts';
import type { OpenAIAccountStore } from './OpenAIAccountStore.ts';
import type { OpenAISavedState } from './OpenAISavedState.ts';

export class FileOpenAIAccountStore implements OpenAIAccountStore {
  readonly state: OpenAISavedState = {
    version: 1,
    hostId: `urn:uuid:${randomUUID()}`,
    accounts: [],
  };

  constructor(readonly directory: string) {}

  async acquire(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
    } catch (error) {
      throw new PersistenceError('Could not prepare the ChatGPT account directory.', { cause: error });
    }
    try {
      await mkdir(join(this.directory, 'session.lock'), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new PersistenceError('Could not acquire the ChatGPT account lock.', { cause: error });
      }
      throw new ConcurrentInstanceError(
        `Another instance may be running. Close it first. After a crash, remove ${join(this.directory, 'session.lock')} only after verifying no instance is running.`,
        { cause: error },
      );
    }
    try {
      await writeFile(join(this.directory, 'session.lock', 'pid'), String(process.pid), { mode: 0o600 });
    } catch (error) {
      await this.release();
      throw new PersistenceError('Could not create the session lock.', { cause: error });
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await this.save();
        return;
      }
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('Could not load ChatGPT account state.', { cause: error });
    }
  }

  async save(): Promise<void> {
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

  async release(): Promise<void> {
    await rm(join(this.directory, 'session.lock'), { recursive: true, force: true });
  }
}

function isOpenAISavedState(raw: unknown): raw is OpenAISavedState {
  if (!raw || typeof raw !== 'object') return false;
  const state = raw as Partial<OpenAISavedState>;
  return state.version === 1
    && typeof state.hostId === 'string'
    && state.hostId.startsWith('urn:uuid:')
    && Array.isArray(state.accounts)
    && state.accounts.every(account =>
      typeof account.clientId === 'string'
      && account.clientId !== 'dynamic_agent_client'
      && typeof account.subject === 'string'
      && typeof account.email === 'string'
      && (!account.tokens || (
        typeof account.tokens.accessToken === 'string'
        && typeof account.tokens.refreshToken === 'string'
        && typeof account.tokens.idToken === 'string'
        && Number.isFinite(account.tokens.expiresAt)
        && Array.isArray(account.tokens.scopes)
        && account.tokens.scopes.every((scope: unknown) => typeof scope === 'string')
      )));
}
