import { AuthenticationError } from '#src/errors/AuthenticationError.js';
import type { OpenAIConfiguration } from '#src/providers/openai/OpenAIConfiguration.js';
import type { AuthorizationHandler } from './AuthorizationHandler.ts';
import type { OpenAIAccount } from './OpenAIAccount.ts';
import type { OpenAIAccountStore } from './OpenAIAccountStore.ts';
import type { OpenAIAuthenticationClient } from './OpenAIAuthenticationClient.ts';
import { OpenAIOAuthError } from './OpenAIOAuthError.ts';
import type { OpenAISessionService } from './OpenAISessionService.ts';
import type { OpenAITokens } from './OpenAITokens.ts';

export class OpenAISession implements OpenAISessionService {
  private readonly secrets = new Set<string>();
  // Borrowed stores share account objects across workspaces. Refresh-token
  // rotation must be serialized for that account, never for unrelated accounts.
  private static readonly pending = new WeakMap<OpenAIAccount, Promise<string>>();
  private static readonly unpersisted = new WeakSet<OpenAIAccount>();
  private disposed = false;
  private readonly saves = new Set<Promise<void>>();

  /** Stop this caller and drain its writes; shared refreshes follow the account owner's lifetime. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled(this.saves);
  }

  constructor(
    private readonly store: OpenAIAccountStore,
    private readonly authentication: OpenAIAuthenticationClient,
    private readonly configuration: OpenAIConfiguration,
    private readonly signal?: AbortSignal,
  ) {}

  redact(message: string): string {
    for (const account of this.store.state.accounts) {
      if (account.tokens) this.remember(account.tokens);
    }
    for (const value of this.secrets) message = message.split(value).join('[REDACTED]');
    return message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]');
  }

  async signIn(existing?: OpenAIAccount, consent = false, authorize?: AuthorizationHandler): Promise<OpenAIAccount> {
    this.assertOpen();
    if (!authorize) throw new AuthenticationError('An authorization handler is required to sign in.');
    const result = await this.authentication.signIn(this.store.state.hostId, existing, consent, this.signal, authorize);
    this.assertOpen();
    this.remember(result.tokens);
    const account: OpenAIAccount = {
      ...result,
      planNoticeSeen: existing?.planNoticeSeen ?? false,
    };
    const index = this.store.state.accounts.findIndex(
      candidate => candidate.clientId === account.clientId && candidate.subject === account.subject,
    );
    if (index < 0) this.store.state.accounts.push(account);
    else this.store.state.accounts[index] = account;
    OpenAISession.unpersisted.add(account);
    await this.persist(account);
    return account;
  }

  async accessToken(account: OpenAIAccount): Promise<string> {
    this.assertOpen();
    const lifetime = this.store.lifetimeSignal;
    if (!account.tokens) throw new AuthenticationError('This account is signed out. Use /login or restart to sign in.');
    if (!account.tokens.scopes.includes(this.configuration.planScope)) {
      throw new AuthenticationError('ChatGPT plan usage was not granted. Use /login to enable it explicitly.');
    }
    this.remember(account.tokens);
    let pending = OpenAISession.pending.get(account);
    if (!pending) {
      if (OpenAISession.unpersisted.has(account)) {
        pending = this.persist(account, { shared: true }).then(() => {
          this.assertRefreshOpen(lifetime);
          if (!account.tokens) throw new AuthenticationError('This account is signed out.');
          return account.tokens.expiresAt > Date.now() + 30_000 ? account.tokens.accessToken : this.refresh(account);
        });
      } else if (account.tokens.expiresAt > Date.now() + 30_000) {
        return account.tokens.accessToken;
      } else {
        pending = this.refresh(account);
      }
      OpenAISession.pending.set(account, pending);
    }
    try {
      const token = await pending;
      this.assertOpen();
      this.assertRefreshOpen(lifetime);
      if (account.tokens?.accessToken !== token || !this.store.state.accounts.includes(account)) {
        throw new AuthenticationError('The account session changed during authentication.');
      }
      return token;
    } finally {
      if (OpenAISession.pending.get(account) === pending) OpenAISession.pending.delete(account);
    }
  }

  async logout(account: OpenAIAccount): Promise<boolean> {
    this.assertOpen();
    if (account.tokens) this.remember(account.tokens);
    // Revoke the captured credentials, but invalidate local refreshes immediately.
    // A slow revoke must not leave a window in which refresh restores the session.
    const revoking = { ...account };
    delete account.tokens;
    OpenAISession.unpersisted.delete(account);
    await this.save();
    this.assertOpen();
    return this.authentication.revoke(revoking, this.signal);
  }

  private remember(tokens: OpenAITokens): void {
    for (const secret of [tokens.accessToken, tokens.refreshToken, tokens.idToken]) this.secrets.add(secret);
  }

  private async persist(account: OpenAIAccount, options: { shared?: boolean } = {}): Promise<void> {
    const tokens = account.tokens;
    await this.save(options);
    if (account.tokens === tokens) OpenAISession.unpersisted.delete(account);
  }

  private async refresh(account: OpenAIAccount): Promise<string> {
    const original = account.tokens;
    // Capture the owner's generation. Reopening the account service must not
    // revive work issued under its previous lock/lifetime.
    const lifetime = this.store.lifetimeSignal;
    const assertCurrent = (): void => {
      this.assertRefreshOpen(lifetime);
      if (account.tokens !== original || !this.store.state.accounts.includes(account)) {
        throw new AuthenticationError('The account session changed during authentication.');
      }
    };
    try {
      const tokens = await this.authentication.refresh(account, lifetime ?? this.signal);
      assertCurrent();
      this.remember(tokens);
      account.tokens = tokens;
      OpenAISession.unpersisted.add(account);
      await this.persist(account, { shared: true });
      if (!tokens.scopes.includes(this.configuration.planScope)) {
        throw new AuthenticationError('ChatGPT plan usage is disabled. Use /login to enable it.');
      }
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof OpenAIOAuthError && terminalRefreshErrors.has(error.code)) {
        assertCurrent();
        delete account.tokens;
        await this.save({ shared: true });
        throw new AuthenticationError('The renewable session expired or was revoked. Use /login to sign in again.', {
          cause: error,
        });
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.disposed || this.signal?.aborted || this.store.lifetimeSignal?.aborted)
      throw new AuthenticationError('The authentication session has stopped.');
  }

  private assertRefreshOpen(lifetime = this.store.lifetimeSignal): void {
    if (!lifetime) return this.assertOpen();
    if (lifetime.aborted) throw new AuthenticationError('The shared account store has stopped.');
  }

  private async save({ shared = false }: { shared?: boolean } = {}): Promise<void> {
    if (shared) this.assertRefreshOpen();
    else this.assertOpen();
    const pending = this.store.save();
    this.saves.add(pending);
    try {
      await pending;
    } finally {
      this.saves.delete(pending);
    }
  }
}

const terminalRefreshErrors = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);
