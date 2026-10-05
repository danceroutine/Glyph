import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { AuthenticationError } from '../../../errors/AuthenticationError.ts';
import { ProtocolError } from '../../../errors/ProtocolError.ts';
import { HttpBodyEncoding } from '../../../http/HttpBodyEncoding.ts';
import type { HttpClient } from '../../../http/HttpClient.ts';
import { HttpResponseBody } from '../../../http/HttpResponseBody.ts';
import { toRecord } from '../../../shared/mappers/toRecord.ts';
import { isRequiredString } from '../../../shared/validators/isRequiredString.ts';
import type { OpenAIConfiguration } from '../OpenAIConfiguration.ts';
import type { AuthorizationHandler } from './AuthorizationHandler.ts';
import type { OpenAIAccount } from './OpenAIAccount.ts';
import type { OpenAIAuthorizationAttempt } from './OpenAIAuthorizationAttempt.ts';
import { OpenAIOAuthError } from './OpenAIOAuthError.ts';
import type { OpenAITokens } from './OpenAITokens.ts';

export class OpenAIAuthenticationClient {
  private readonly verificationKey: JWTVerifyGetKey;

  constructor(
    private readonly configuration: OpenAIConfiguration,
    private readonly http: HttpClient,
    verificationKey?: JWTVerifyGetKey,
  ) {
    this.verificationKey = verificationKey
      ?? createRemoteJWKSet(new URL(`${configuration.issuer}/.well-known/jwks.json`));
  }

  createAuthorizationAttempt(
    hostId: string,
    redirectUri: string,
    clientId?: string,
    consent = false,
  ): OpenAIAuthorizationAttempt {
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL(`${this.configuration.issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: this.configuration.scopes,
      resource: this.configuration.resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      ...(!clientId ? { agent_name_hint: 'Harness Chat' } : {}),
      ...(consent ? { prompt: 'consent' } : {}),
    }).toString();
    return { state, nonce, verifier, url: url.toString(), redirectUri, clientId };
  }

  validateAuthorizationCallback(
    url: URL,
    attempt: OpenAIAuthorizationAttempt,
  ): { code: string; clientId: string } {
    for (const key of ['state', 'code', 'client_id', 'error']) {
      if (url.searchParams.getAll(key).length > 1) throw new ProtocolError('Duplicate OAuth callback parameter.');
    }
    const state = url.searchParams.get('state') ?? '';
    if (Buffer.byteLength(state) !== Buffer.byteLength(attempt.state)
      || !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) {
      throw new AuthenticationError('OAuth state mismatch.');
    }
    if (url.searchParams.has('error')) throw new AuthenticationError('Sign-in was declined or could not be completed.');
    const returnedId = url.searchParams.get('client_id');
    if (attempt.clientId && returnedId && attempt.clientId !== returnedId) {
      throw new AuthenticationError('OAuth client ID changed during reauthorization.');
    }
    const clientId = returnedId ?? attempt.clientId;
    if (!clientId || clientId === 'dynamic_agent_client') {
      throw new AuthenticationError('Registration did not return an issued client ID.');
    }
    return { clientId, code: this.toRequiredString(url.searchParams.get('code'), 'authorization code') };
  }

  async verifyIdentity(
    idToken: string,
    clientId: string,
    nonce?: string,
    subject?: string,
  ): Promise<{ subject: string; email: string }> {
    const { payload } = await jwtVerify(idToken, this.verificationKey, {
      issuer: this.configuration.issuer,
      audience: clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
    });
    if (nonce !== undefined && payload.nonce !== nonce) throw new AuthenticationError('ID token nonce mismatch.');
    if (subject !== undefined && payload.sub !== subject) {
      throw new AuthenticationError('The signed-in identity does not match this saved account.');
    }
    return {
      subject: this.toRequiredString(payload.sub, 'subject'),
      email: typeof payload.email === 'string' ? payload.email : '(email unavailable)',
    };
  }

  toTokens(body: Record<string, unknown>, previous?: OpenAITokens): OpenAITokens {
    if (String(body.token_type).toLowerCase() !== 'bearer') throw new ProtocolError('Expected a Bearer token.');
    const expiresIn = body.expires_in;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new ProtocolError('Invalid token expiry.');
    }
    const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
    if (!scopes) throw new ProtocolError('Token response did not include granted scopes.');
    return {
      accessToken: this.toRequiredString(body.access_token, 'access_token'),
      refreshToken: this.toRequiredString(body.refresh_token ?? previous?.refreshToken, 'refresh_token'),
      idToken: this.toRequiredString(body.id_token ?? previous?.idToken, 'id_token'),
      expiresAt: Date.now() + expiresIn * 1000,
      scopes,
    };
  }

  async exchangeToken(form: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.http.post(`${this.configuration.issuer}/api/accounts/oauth/token`, {
      body: form,
      bodyEncoding: HttpBodyEncoding.FORM,
      redirect: 'error',
      ...(signal ? { signal } : {}),
      timeoutMs: this.configuration.requestTimeoutMs,
    });
    const body = toRecord(response.body);
    if (!response.ok) {
      throw new OpenAIOAuthError(
        typeof body.error === 'string' ? body.error : 'token_exchange_failed',
        response.status,
      );
    }
    return body;
  }

  async signIn(
    hostId: string,
    existing: OpenAIAccount | undefined,
    consent: boolean,
    signal: AbortSignal | undefined,
    authorize: AuthorizationHandler,
  ): Promise<{ clientId: string; subject: string; email: string; tokens: OpenAITokens }> {
    let resolveCallback!: (value: { code: string; clientId: string }) => void;
    let rejectCallback!: (reason: Error) => void;
    const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    void callback.catch(() => {});
    let attempt: OpenAIAuthorizationAttempt | undefined;
    let consumed = false;
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Content-Security-Policy', "default-src 'none'");
      response.setHeader('Referrer-Policy', 'no-referrer');
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== '/auth/callback' || !attempt || consumed) {
        response.writeHead(404).end('Not found.');
        return;
      }
      try {
        const value = this.validateAuthorizationCallback(url, attempt);
        consumed = true;
        response.end('Authorization received. Return to the application to finish verification.');
        resolveCallback(value);
      } catch (error) {
        response.writeHead(400).end('Authorization rejected. Return to the application.');
        if (url.searchParams.get('state') === attempt.state) {
          consumed = true;
          rejectCallback(error instanceof Error ? error : new AuthenticationError('OAuth callback rejected.'));
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new AuthenticationError('Could not bind the local callback.');
    }
    attempt = this.createAuthorizationAttempt(
      hostId,
      `http://127.0.0.1:${address.port}/auth/callback`,
      existing?.clientId,
      consent,
    );
    const timer = setTimeout(() => rejectCallback(new AuthenticationError('Sign-in timed out after five minutes.')), 300_000);
    const cancel = () => rejectCallback(new AuthenticationError('Sign-in cancelled.'));
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    try {
      await authorize({ url: attempt.url });
      const { code, clientId } = await callback;
      const body = await this.exchangeToken({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
        resource: this.configuration.resource,
      }, signal);
      const identity = await this.verifyIdentity(
        this.toRequiredString(body.id_token, 'id_token'),
        clientId,
        attempt.nonce,
        existing?.subject,
      );
      return { clientId, ...identity, tokens: this.toTokens(body) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  async refresh(account: OpenAIAccount, signal?: AbortSignal): Promise<OpenAITokens> {
    const previous = account.tokens;
    if (!previous) throw new AuthenticationError('Sign in again.');
    const body = await this.exchangeToken({
      grant_type: 'refresh_token',
      client_id: account.clientId,
      refresh_token: previous.refreshToken,
      resource: this.configuration.resource,
    }, signal);
    if (body.id_token) {
      await this.verifyIdentity(
        this.toRequiredString(body.id_token, 'id_token'),
        account.clientId,
        undefined,
        account.subject,
      );
    }
    return this.toTokens(body, previous);
  }

  async revoke(account: OpenAIAccount, signal?: AbortSignal): Promise<boolean> {
    if (!account.tokens) return true;
    try {
      const discovery = await this.http.get(`${this.configuration.issuer}/.well-known/openid-configuration`, {
        redirect: 'error',
        ...(signal ? { signal } : {}),
        timeoutMs: 10_000,
      });
      if (!discovery.ok) return false;
      const endpoint = new URL(this.toRequiredString(toRecord(discovery.body).revocation_endpoint, 'revocation_endpoint'));
      if (endpoint.origin !== this.configuration.issuer) throw new ProtocolError('Unexpected revocation origin.');
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await this.http.post(endpoint, {
            body: {
              token: account.tokens.refreshToken,
              token_type_hint: 'refresh_token',
              client_id: account.clientId,
            },
            bodyEncoding: HttpBodyEncoding.FORM,
            responseBody: HttpResponseBody.NONE,
            redirect: 'error',
            ...(signal ? { signal } : {}),
            timeoutMs: 10_000,
          });
          if (response.status === 200) return true;
          if (response.status < 500) return false;
        } catch {
          // One bounded retry while the token remains available.
        }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch {
      // The caller still clears local tokens when revocation cannot be confirmed.
    }
    return false;
  }

  private toRequiredString(value: unknown, field: string): string {
    if (!isRequiredString(value)) throw new ProtocolError(`Server response missing ${field}.`);
    return value;
  }
}
