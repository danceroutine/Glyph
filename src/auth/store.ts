import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scopes: string[];
}
export interface Account {
  clientId: string;
  subject: string;
  email: string;
  tokens?: Tokens;
  planNoticeSeen?: boolean;
}
export interface SavedState {
  version: 1;
  hostId: string;
  accounts: Account[];
}
export class CredentialStore {
  readonly directory: string;
  state: SavedState = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
  constructor(directory = process.env.HARNESS_CHAT_CONFIG_DIR ?? join(homedir(), '.config', 'harness-chat-chatgpt')) {
    this.directory = directory;
  }
  async acquire(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      await mkdir(join(this.directory, 'session.lock'), { mode: 0o700 });
    } catch {
      throw new Error(`Another instance may be running. Close it first. After a crash, remove ${join(this.directory, 'session.lock')} only after verifying no instance is running.`);
    }
    await writeFile(join(this.directory, 'session.lock', 'pid'), String(process.pid), { mode: 0o600 });
  }
  async load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.directory, 'accounts.json'), 'utf8'));
      if (!isState(raw)) throw new Error('Credential file is invalid. Restore it or move it aside before restarting.');
      this.state = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.save();
    }
  }
  async save(): Promise<void> {
    const temporary = join(this.directory, `accounts.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(this.state, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(this.directory, 'accounts.json'));
    } finally { await rm(temporary, { force: true }); }
  }
  async release(): Promise<void> {
    await rm(join(this.directory, 'session.lock'), { recursive: true, force: true });
  }
}
function isState(raw: unknown): raw is SavedState {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Partial<SavedState>;
  return s.version === 1 && typeof s.hostId === 'string' && s.hostId.startsWith('urn:uuid:') && Array.isArray(s.accounts) && s.accounts.every(a =>
    typeof a.clientId === 'string' && a.clientId !== 'dynamic_agent_client' && typeof a.subject === 'string' && typeof a.email === 'string' &&
    (!a.tokens || (typeof a.tokens.accessToken === 'string' && typeof a.tokens.refreshToken === 'string' && typeof a.tokens.idToken === 'string' && Number.isFinite(a.tokens.expiresAt) && Array.isArray(a.tokens.scopes) && a.tokens.scopes.every((x: unknown) => typeof x === 'string'))));
}
