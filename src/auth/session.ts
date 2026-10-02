import { exchange, ISSUER, PLAN_SCOPE, record, requiredString, RESOURCE, verifyIdentity, OAuthError } from './protocol.ts';
import { login } from './login.ts';
import type { Account, Tokens } from './store.ts';
import { CredentialStore } from './store.ts';

export function parseTokens(body: Record<string, unknown>, previous?: Tokens): Tokens {
  if (String(body.token_type).toLowerCase() !== 'bearer') throw new Error('Expected a Bearer token.');
  const expiresIn = body.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('Invalid token expiry.');
  const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
  if (!scopes) throw new Error('Token response did not include granted scopes.');
  return {
    accessToken: requiredString(body.access_token, 'access_token'),
    refreshToken: requiredString(body.refresh_token ?? previous?.refreshToken, 'refresh_token'),
    idToken: requiredString(body.id_token ?? previous?.idToken, 'id_token'),
    expiresAt: Date.now() + expiresIn * 1000,
    scopes,
  };
}
export class Session {
  readonly store: CredentialStore;
  private readonly secrets = new Set<string>();
  private pending: Promise<string> | undefined;
  constructor(store: CredentialStore) { this.store = store; }
  private remember(tokens: Tokens): void {
    for (const secret of [tokens.accessToken, tokens.refreshToken, tokens.idToken]) this.secrets.add(secret);
  }
  redact(message: string): string {
    for (const account of this.store.state.accounts) if (account.tokens) this.remember(account.tokens);
    for (const value of this.secrets) message = message.split(value).join('[REDACTED]');
    return message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]');
  }
  async signIn(existing?: Account, consent = false): Promise<Account> {
    const result = await login(this.store.state.hostId, existing, consent);
    const tokens = parseTokens(result.response);
    this.remember(tokens);
    const account: Account = { clientId: result.clientId, subject: result.subject, email: result.email, tokens, planNoticeSeen: existing?.planNoticeSeen ?? false };
    const index = this.store.state.accounts.findIndex(a => a.clientId === account.clientId && a.subject === account.subject);
    if (index < 0) this.store.state.accounts.push(account);
    else this.store.state.accounts[index] = account;
    await this.store.save();
    return account;
  }
  async accessToken(account: Account): Promise<string> {
    if (!account.tokens) throw new Error('This account is signed out. Use /login or restart to sign in.');
    if (!account.tokens.scopes.includes(PLAN_SCOPE)) throw new Error('ChatGPT plan usage was not granted. Use /login to enable it explicitly.');
    this.remember(account.tokens);
    if (account.tokens.expiresAt > Date.now() + 30_000) return account.tokens.accessToken;
    // The process-wide file lock prevents cross-process rotation races.
    if (!this.pending) this.pending = this.refresh(account);
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  private async refresh(account: Account): Promise<string> {
    const previous = account.tokens;
    if (!previous) throw new Error('Sign in again.');
    try {
      const response = await exchange({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: previous.refreshToken, resource: RESOURCE });
      if (response.id_token) await verifyIdentity(requiredString(response.id_token, 'id_token'), account.clientId, undefined, account.subject);
      const tokens = parseTokens(response, previous);
      this.remember(tokens);
      account.tokens = tokens;
      await this.store.save();
      if (!tokens.scopes.includes(PLAN_SCOPE)) throw new Error('ChatGPT plan usage is disabled. Use /login to enable it.');
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof OAuthError && ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(error.code)) {
        delete account.tokens;
        await this.store.save();
        throw new Error('The renewable session expired or was revoked. Use /login to sign in again.');
      }
      throw error;
    }
  }
  async logout(account: Account): Promise<boolean> {
    let revoked = !account.tokens;
    if (account.tokens) {
      this.remember(account.tokens);
      try {
        const discovery = await fetch(`${ISSUER}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (!discovery.ok) throw new Error('Discovery unavailable.');
        const metadata = record(await discovery.json());
        const endpoint = new URL(requiredString(metadata.revocation_endpoint, 'revocation_endpoint'));
        if (endpoint.origin !== ISSUER) throw new Error('Unexpected revocation origin.');
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.tokens.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }), signal: AbortSignal.timeout(10_000) });
            if (response.status === 200) { revoked = true; break; }
            if (response.status < 500) break;
          } catch { /* One bounded retry while the token remains available. */ }
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch { /* Clear local tokens even when revocation cannot be confirmed. */ }
    }
    delete account.tokens;
    await this.store.save();
    return revoked;
  }
}
