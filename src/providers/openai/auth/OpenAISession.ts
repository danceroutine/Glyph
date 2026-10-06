import { AuthenticationError } from '../../../errors/AuthenticationError.ts';
import type { OpenAIConfiguration } from '../OpenAIConfiguration.ts';
import type { AuthorizationHandler } from './AuthorizationHandler.ts';
import type { OpenAIAccount } from './OpenAIAccount.ts';
import type { OpenAIAccountStore } from './OpenAIAccountStore.ts';
import type { OpenAIAuthenticationClient } from './OpenAIAuthenticationClient.ts';
import { OpenAIOAuthError } from './OpenAIOAuthError.ts';
import type { OpenAISessionService } from './OpenAISessionService.ts';
import type { OpenAITokens } from './OpenAITokens.ts';

export class OpenAISession implements OpenAISessionService {
  private readonly secrets = new Set<string>();
  private pending: Promise<string> | undefined;

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
    if (!authorize) throw new AuthenticationError('An authorization handler is required to sign in.');
    const result = await this.authentication.signIn(this.store.state.hostId, existing, consent, this.signal, authorize);
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
    await this.store.save();
    return account;
  }

  async accessToken(account: OpenAIAccount): Promise<string> {
    if (!account.tokens) throw new AuthenticationError('This account is signed out. Use /login or restart to sign in.');
    if (!account.tokens.scopes.includes(this.configuration.planScope)) {
      throw new AuthenticationError('ChatGPT plan usage was not granted. Use /login to enable it explicitly.');
    }
    this.remember(account.tokens);
    if (account.tokens.expiresAt > Date.now() + 30_000) return account.tokens.accessToken;
    if (!this.pending) this.pending = this.refresh(account);
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  async logout(account: OpenAIAccount): Promise<boolean> {
    if (account.tokens) this.remember(account.tokens);
    const revoked = await this.authentication.revoke(account, this.signal);
    delete account.tokens;
    await this.store.save();
    return revoked;
  }

  private remember(tokens: OpenAITokens): void {
    for (const secret of [tokens.accessToken, tokens.refreshToken, tokens.idToken]) this.secrets.add(secret);
  }

  private async refresh(account: OpenAIAccount): Promise<string> {
    try {
      const tokens = await this.authentication.refresh(account, this.signal);
      this.remember(tokens);
      account.tokens = tokens;
      await this.store.save();
      if (!tokens.scopes.includes(this.configuration.planScope)) {
        throw new AuthenticationError('ChatGPT plan usage is disabled. Use /login to enable it.');
      }
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof OpenAIOAuthError && terminalRefreshErrors.has(error.code)) {
        delete account.tokens;
        await this.store.save();
        throw new AuthenticationError('The renewable session expired or was revoked. Use /login to sign in again.', {
          cause: error,
        });
      }
      throw error;
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
