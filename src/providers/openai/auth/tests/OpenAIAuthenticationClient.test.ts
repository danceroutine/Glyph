import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { AuthenticationError } from '#src/errors/AuthenticationError.js';
import { ProtocolError } from '#src/errors/ProtocolError.js';
import { HttpBodyEncoding } from '#src/http/HttpBodyEncoding.js';
import type { HttpClient } from '#src/http/HttpClient.js';
import { HttpResponseBody } from '#src/http/HttpResponseBody.js';
import type { OpenAIConfiguration } from '#src/providers/openai/OpenAIConfiguration.js';
import { OpenAIAuthenticationClient } from '#src/providers/openai/auth/OpenAIAuthenticationClient.js';
import { OpenAIOAuthError } from '#src/providers/openai/auth/OpenAIOAuthError.js';

vi.mock('node:http', async importOriginal => {
  const actual = await importOriginal<typeof import('node:http')>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});

const configuration: OpenAIConfiguration = {
  issuer: 'https://auth.example.test',
  resource: 'https://api.example.test/v1',
  scopes: 'openid profile offline_access plan',
  planScope: 'plan',
  requestTimeoutMs: 30_000,
};

function http(): HttpClient {
  return { get: vi.fn(), post: vi.fn() };
}

function idToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  { audience, subject }: { audience: string; subject: string },
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(configuration.issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function visit(port: string, path: string, method = 'GET'): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    httpRequest({ hostname: '127.0.0.1', port, path, method }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
      });
      response.once('end', () => resolve({ status: response.statusCode, body }));
      response.once('error', reject);
    })
      .once('error', reject)
      .end();
  });
}

function authorization(url: string) {
  const parsed = new URL(url);
  const redirect = new URL(parsed.searchParams.get('redirect_uri')!);
  return {
    parsed,
    port: redirect.port,
    state: parsed.searchParams.get('state')!,
    nonce: parsed.searchParams.get('nonce')!,
  };
}

describe(OpenAIAuthenticationClient, () => {
  it('can be constructed with the issuer key set instead of an injected verification key', () => {
    expect(new OpenAIAuthenticationClient(configuration, http())).toBeInstanceOf(OpenAIAuthenticationClient);
  });

  describe(OpenAIAuthenticationClient.prototype.signIn, () => {
    it('rejects a malformed callback URL without crashing or consuming the authorization attempt', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      let nonce = '';
      const client = new OpenAIAuthenticationClient(
        {
          issuer: 'https://auth.example.test',
          resource: 'https://api.example.test',
          scopes: 'openid',
          planScope: 'plan',
          requestTimeoutMs: 1000,
        },
        {
          get: vi.fn(),
          post: vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            body: {
              access_token: 'fixture-access',
              refresh_token: 'fixture-refresh',
              token_type: 'Bearer',
              expires_in: 3600,
              scope: 'openid',
              id_token: await idToken(
                privateKey,
                { nonce, email: 'fixture@example.test' },
                { audience: 'fixture-client', subject: 'fixture-subject' },
              ),
            },
          })),
        },
        async () => publicKey,
      );
      const statuses: (number | undefined)[] = [];

      const result = await client.signIn(
        'fixture-host',
        undefined,
        false,
        AbortSignal.timeout(5000),
        async ({ url }) => {
          const callback = authorization(url);
          nonce = callback.nonce;
          statuses.push((await visit(callback.port, '//[')).status);
          statuses.push(
            (
              await visit(
                callback.port,
                `/auth/callback?${new URLSearchParams({ state: callback.state, code: 'fixture-code', client_id: 'fixture-client' })}`,
              )
            ).status,
          );
        },
      );

      expect(statuses).toEqual([400, 200]);
      expect(result.subject).toBe('fixture-subject');
      expect(result.clientId).toBe('fixture-client');
    });

    it('serves only the matching callback once and exchanges its code for verified tokens', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      let nonce = '';
      const post = vi.fn<HttpClient['post']>(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          access_token: 'access',
          refresh_token: 'refresh',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'openid  plan',
          id_token: await idToken(
            privateKey,
            { nonce, email: 'developer@example.com' },
            { audience: 'issued-client', subject: 'subject' },
          ),
        },
      }));
      const client = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post }, async () => publicKey);
      const responses: { status: number | undefined; body: string }[] = [];
      let redirectUri = '';

      const result = await client.signIn('urn:uuid:host', undefined, false, undefined, async ({ url }) => {
        const callback = authorization(url);
        nonce = callback.nonce;
        redirectUri = callback.parsed.searchParams.get('redirect_uri')!;
        const valid = `/auth/callback?${new URLSearchParams({ state: callback.state, code: 'code', client_id: 'issued-client' })}`;
        responses.push(await visit(callback.port, '/elsewhere'));
        responses.push(await visit(callback.port, valid, 'POST'));
        responses.push(await visit(callback.port, '/auth/callback?state=wrong&code=code&client_id=issued-client'));
        responses.push(await visit(callback.port, valid));
        responses.push(await visit(callback.port, valid));
      });

      expect(responses).toEqual([
        { status: 404, body: 'Not found.' },
        { status: 404, body: 'Not found.' },
        { status: 400, body: 'Authorization rejected. Return to the application.' },
        { status: 200, body: 'Authorization received. Return to the application to finish verification.' },
        { status: 404, body: 'Not found.' },
      ]);
      expect(result).toEqual({
        clientId: 'issued-client',
        subject: 'subject',
        email: 'developer@example.com',
        tokens: {
          accessToken: 'access',
          refreshToken: 'refresh',
          idToken: expect.any(String),
          expiresAt: expect.any(Number),
          scopes: ['openid', 'plan'],
        },
      });
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
      expect(post).toHaveBeenCalledWith(`${configuration.issuer}/api/accounts/oauth/token`, {
        body: {
          grant_type: 'authorization_code',
          client_id: 'issued-client',
          code: 'code',
          code_verifier: expect.any(String),
          redirect_uri: redirectUri,
          resource: configuration.resource,
        },
        bodyEncoding: HttpBodyEncoding.FORM,
        redirect: 'error',
        timeoutMs: configuration.requestTimeoutMs,
      });
    });

    it('sends security headers on callback responses', async () => {
      const client = new OpenAIAuthenticationClient(configuration, http(), async () => {
        throw new Error('unused');
      });
      const controller = new AbortController();
      let headers: Record<string, string | string[] | undefined> = {};

      const signIn = client.signIn('urn:uuid:host', undefined, false, controller.signal, async ({ url }) => {
        const callback = authorization(url);
        headers = await new Promise(resolve => {
          httpRequest({ hostname: '127.0.0.1', port: callback.port, path: '/elsewhere' }, response => {
            response.resume();
            resolve(response.headers);
          }).end();
        });
        controller.abort();
      });

      await expect(signIn).rejects.toThrow('Sign-in cancelled.');
      expect(headers).toMatchObject({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'content-security-policy': "default-src 'none'",
        'referrer-policy': 'no-referrer',
      });
    });

    it('reauthorizes a saved account with consent and keeps its client ID when the callback omits it', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      let nonce = '';
      const post = vi.fn<HttpClient['post']>(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          access_token: 'access',
          refresh_token: 'refresh',
          token_type: 'Bearer',
          expires_in: 60,
          scope: 'openid',
          id_token: await idToken(privateKey, { nonce }, { audience: 'saved-client', subject: 'saved-subject' }),
        },
      }));
      const client = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post }, async () => publicKey);
      const signal = new AbortController().signal;
      let authorizationUrl!: URL;

      const result = await client.signIn(
        'urn:uuid:host',
        { clientId: 'saved-client', subject: 'saved-subject', email: 'old@example.com' },
        true,
        signal,
        async ({ url }) => {
          const callback = authorization(url);
          authorizationUrl = callback.parsed;
          nonce = callback.nonce;
          await visit(callback.port, `/auth/callback?${new URLSearchParams({ state: callback.state, code: 'code' })}`);
        },
      );

      expect(authorizationUrl.searchParams.get('client_id')).toBe('saved-client');
      expect(authorizationUrl.searchParams.get('prompt')).toBe('consent');
      expect(authorizationUrl.searchParams.has('agent_name_hint')).toBe(false);
      expect(result).toMatchObject({
        clientId: 'saved-client',
        subject: 'saved-subject',
        email: '(email unavailable)',
      });
      expect(post).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal }));
    });

    it('fails when the authorization server declines the request', async () => {
      const post = vi.fn<HttpClient['post']>();
      const client = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post });
      let response: { status: number | undefined; body: string } | undefined;

      await expect(
        client.signIn('urn:uuid:host', undefined, false, undefined, async ({ url }) => {
          const callback = authorization(url);
          response = await visit(callback.port, `/auth/callback?state=${callback.state}&error=access_denied`);
        }),
      ).rejects.toThrow('Sign-in was declined or could not be completed.');
      expect(response).toEqual({ status: 400, body: 'Authorization rejected. Return to the application.' });
      expect(post).not.toHaveBeenCalled();
    });

    it('reports a generic rejection when callback validation fails with a non-error value', async () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      vi.spyOn(client, 'validateAuthorizationCallback').mockImplementation(() => {
        throw 'invalid';
      });

      await expect(
        client.signIn('urn:uuid:host', undefined, false, undefined, async ({ url }) => {
          const callback = authorization(url);
          await visit(callback.port, `/auth/callback?state=${callback.state}&code=code`);
        }),
      ).rejects.toThrow(new AuthenticationError('OAuth callback rejected.'));
    });

    it('rejects callback requests that arrive without a request target', async () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const controller = new AbortController();
      const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
      response.writeHead.mockReturnValue(response);

      await expect(
        client.signIn('urn:uuid:host', undefined, false, controller.signal, async () => {
          const handler = vi.mocked(createServer).mock.lastCall![0] as unknown as (
            request: unknown,
            response: unknown,
          ) => void;
          handler({ method: 'GET' }, response);
          controller.abort();
        }),
      ).rejects.toThrow('Sign-in cancelled.');
      expect(response.writeHead).toHaveBeenCalledWith(404);
      expect(response.end).toHaveBeenCalledWith('Not found.');
    });

    it('fails when the local callback has no network address', async () => {
      const actual = await vi.importActual<typeof import('node:http')>('node:http');
      vi.mocked(createServer).mockImplementationOnce(((handler: Parameters<typeof actual.createServer>[0]) => {
        const server = actual.createServer(handler);
        server.address = () => null;
        return server;
      }) as unknown as typeof createServer);
      const authorize = vi.fn();

      await expect(
        new OpenAIAuthenticationClient(configuration, http()).signIn(
          'urn:uuid:host',
          undefined,
          false,
          undefined,
          authorize,
        ),
      ).rejects.toThrow('Could not bind the local callback.');
      expect(authorize).not.toHaveBeenCalled();
    });

    it('fails immediately when already cancelled', async () => {
      const post = vi.fn<HttpClient['post']>();
      const client = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post });

      await expect(
        client.signIn('urn:uuid:host', undefined, false, AbortSignal.abort(), async () => {}),
      ).rejects.toThrow('Sign-in cancelled.');
      expect(post).not.toHaveBeenCalled();
    });

    it('times out after five minutes without a callback', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const client = new OpenAIAuthenticationClient(configuration, http());

      await expect(
        client.signIn('urn:uuid:host', undefined, false, undefined, () => {
          vi.advanceTimersByTime(300_000);
        }),
      ).rejects.toThrow('Sign-in timed out after five minutes.');
    });
  });

  describe(OpenAIAuthenticationClient.prototype.createAuthorizationAttempt, () => {
    it('creates a PKCE authorization request for a dynamic client', () => {
      const attempt = new OpenAIAuthenticationClient(configuration, http()).createAuthorizationAttempt(
        'urn:uuid:host',
        'http://127.0.0.1/callback',
      );
      const url = new URL(attempt.url);

      expect(url.origin).toBe(configuration.issuer);
      expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('agent_name_hint')).toBe('Glyph');
    });

    it('describes the full authorization request and returns its secrets', () => {
      const attempt = new OpenAIAuthenticationClient(configuration, http()).createAuthorizationAttempt(
        'urn:uuid:host',
        'http://127.0.0.1/callback',
        'issued-client',
        true,
      );
      const url = new URL(attempt.url);

      expect(url.pathname).toBe('/api/accounts/authorize');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: 'issued-client',
        ext_agent_host_id: 'urn:uuid:host',
        response_type: 'code',
        redirect_uri: 'http://127.0.0.1/callback',
        scope: configuration.scopes,
        resource: configuration.resource,
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge_method: 'S256',
        code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        prompt: 'consent',
      });
      expect(attempt).toMatchObject({ redirectUri: 'http://127.0.0.1/callback', clientId: 'issued-client' });
      expect(attempt.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  describe(OpenAIAuthenticationClient.prototype.validateAuthorizationCallback, () => {
    it('rejects a callback whose state does not match the authorization attempt', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback', 'client');
      const callback = new URL(`http://127.0.0.1/callback?state=wrong&code=code&client_id=client`);

      expect(() => client.validateAuthorizationCallback(callback, attempt)).toThrow(AuthenticationError);
    });

    it('accepts a matching callback and returns its code and issued client ID', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback');
      const callback = new URL(`http://127.0.0.1/callback?state=${attempt.state}&code=code&client_id=issued`);

      expect(client.validateAuthorizationCallback(callback, attempt)).toEqual({ code: 'code', clientId: 'issued' });
    });

    it.each(['state', 'code', 'client_id', 'error'])('rejects a callback that repeats the %s parameter', key => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback');
      const callback = new URL(`http://127.0.0.1/callback?state=${attempt.state}&code=code&client_id=issued`);
      callback.searchParams.append(key, 'again');
      callback.searchParams.append(key, 'repeated');

      expect(() => client.validateAuthorizationCallback(callback, attempt)).toThrow(
        new ProtocolError('Duplicate OAuth callback parameter.'),
      );
    });

    it('rejects a callback without a state', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback');

      expect(() =>
        client.validateAuthorizationCallback(new URL('http://127.0.0.1/callback?code=code'), attempt),
      ).toThrow(new AuthenticationError('OAuth state mismatch.'));
    });

    it('rejects a callback whose state has the right length but different content', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback');
      const forged = `${attempt.state.startsWith('A') ? 'B' : 'A'}${attempt.state.slice(1)}`;

      expect(() =>
        client.validateAuthorizationCallback(new URL(`http://127.0.0.1/callback?state=${forged}&code=code`), attempt),
      ).toThrow(new AuthenticationError('OAuth state mismatch.'));
    });

    it('rejects a reauthorization that returns a different client ID', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback', 'saved');

      expect(() =>
        client.validateAuthorizationCallback(
          new URL(`http://127.0.0.1/callback?state=${attempt.state}&code=code&client_id=other`),
          attempt,
        ),
      ).toThrow(new AuthenticationError('OAuth client ID changed during reauthorization.'));
    });

    it('accepts a reauthorization that echoes the saved client ID', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback', 'saved');

      expect(
        client.validateAuthorizationCallback(
          new URL(`http://127.0.0.1/callback?state=${attempt.state}&code=code&client_id=saved`),
          attempt,
        ),
      ).toEqual({ code: 'code', clientId: 'saved' });
    });

    it.each([
      ['no client ID at all', ''],
      ['the placeholder dynamic client ID', '&client_id=dynamic_agent_client'],
    ])('rejects a registration that returns %s', (_case, query) => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback');

      expect(() =>
        client.validateAuthorizationCallback(
          new URL(`http://127.0.0.1/callback?state=${attempt.state}&code=code${query}`),
          attempt,
        ),
      ).toThrow(new AuthenticationError('Registration did not return an issued client ID.'));
    });

    it('rejects a callback without an authorization code', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback');

      expect(() =>
        client.validateAuthorizationCallback(
          new URL(`http://127.0.0.1/callback?state=${attempt.state}&client_id=issued`),
          attempt,
        ),
      ).toThrow(new ProtocolError('Server response missing authorization code.'));
    });
  });

  describe(OpenAIAuthenticationClient.prototype.toTokens, () => {
    it('retains renewable credentials and scopes omitted by a refresh response', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const previous = client.toTokens({
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: 'id',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'openid plan',
      });

      expect(client.toTokens({ access_token: 'next', token_type: 'Bearer', expires_in: 3600 }, previous)).toEqual(
        expect.objectContaining({ accessToken: 'next', refreshToken: 'refresh', scopes: ['openid', 'plan'] }),
      );
    });

    it('computes the expiry from the current time', () => {
      vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const client = new OpenAIAuthenticationClient(configuration, http());

      expect(
        client.toTokens({
          access_token: 'access',
          refresh_token: 'refresh',
          id_token: 'id',
          token_type: 'Bearer',
          expires_in: 60,
          scope: '',
        }),
      ).toEqual({ accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: 1_060_000, scopes: [] });
    });

    it.each([undefined, 'mac'])('rejects a %s token type', tokenType => {
      const client = new OpenAIAuthenticationClient(configuration, http());

      expect(() => client.toTokens({ token_type: tokenType, expires_in: 60 })).toThrow(
        new ProtocolError('Expected a Bearer token.'),
      );
    });

    it.each(['60', Number.POSITIVE_INFINITY, 0, -1])('rejects the token expiry %s', expiresIn => {
      const client = new OpenAIAuthenticationClient(configuration, http());

      expect(() => client.toTokens({ token_type: 'Bearer', expires_in: expiresIn })).toThrow(
        new ProtocolError('Invalid token expiry.'),
      );
    });

    it('rejects a first token response without granted scopes', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());

      expect(() =>
        client.toTokens({ access_token: 'a', refresh_token: 'r', id_token: 'i', token_type: 'Bearer', expires_in: 60 }),
      ).toThrow(new ProtocolError('Token response did not include granted scopes.'));
    });

    it.each([
      ['access_token', { refresh_token: 'r', id_token: 'i' }],
      ['refresh_token', { access_token: 'a', id_token: 'i' }],
      ['id_token', { access_token: 'a', refresh_token: 'r' }],
    ])('rejects a response missing %s', (field, body) => {
      const client = new OpenAIAuthenticationClient(configuration, http());

      expect(() => client.toTokens({ ...body, token_type: 'Bearer', expires_in: 60, scope: 'openid' })).toThrow(
        new ProtocolError(`Server response missing ${field}.`),
      );
    });
  });

  describe(OpenAIAuthenticationClient.prototype.verifyIdentity, () => {
    it('verifies issuer, audience, nonce, subject, and email claims', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const jwk = await exportJWK(publicKey);
      const token = await new SignJWT({ email: 'developer@example.com', nonce: 'nonce' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuer(configuration.issuer)
        .setAudience('client')
        .setSubject('subject')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      const client = new OpenAIAuthenticationClient(configuration, http(), async () => publicKey);

      expect(await client.verifyIdentity(token, 'client', 'nonce', 'subject')).toEqual({
        subject: 'subject',
        email: 'developer@example.com',
      });
      expect(jwk.kty).toBe('RSA');
    });

    it('rejects a token issued for another nonce', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const token = await idToken(privateKey, { nonce: 'other' }, { audience: 'client', subject: 'subject' });
      const client = new OpenAIAuthenticationClient(configuration, http(), async () => publicKey);

      await expect(client.verifyIdentity(token, 'client', 'nonce')).rejects.toThrow(
        new AuthenticationError('ID token nonce mismatch.'),
      );
    });

    it('rejects a token for a different identity than the saved account', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const token = await idToken(privateKey, {}, { audience: 'client', subject: 'someone-else' });
      const client = new OpenAIAuthenticationClient(configuration, http(), async () => publicKey);

      await expect(client.verifyIdentity(token, 'client', undefined, 'subject')).rejects.toThrow(
        new AuthenticationError('The signed-in identity does not match this saved account.'),
      );
    });

    it('rejects a token with an empty subject', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const token = await idToken(privateKey, {}, { audience: 'client', subject: '' });
      const client = new OpenAIAuthenticationClient(configuration, http(), async () => publicKey);

      await expect(client.verifyIdentity(token, 'client')).rejects.toThrow(
        new ProtocolError('Server response missing subject.'),
      );
    });

    it('rejects a token for another audience', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const token = await idToken(privateKey, {}, { audience: 'other-client', subject: 'subject' });
      const client = new OpenAIAuthenticationClient(configuration, http(), async () => publicKey);

      await expect(client.verifyIdentity(token, 'client')).rejects.toThrow();
    });
  });

  describe(OpenAIAuthenticationClient.prototype.exchangeToken, () => {
    it('posts the form to the token endpoint and returns the response body', async () => {
      const post = vi.fn<HttpClient['post']>(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { access_token: 'access' },
      }));
      const client = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post });

      await expect(client.exchangeToken({ grant_type: 'test' })).resolves.toEqual({ access_token: 'access' });
      expect(post).toHaveBeenCalledWith(`${configuration.issuer}/api/accounts/oauth/token`, {
        body: { grant_type: 'test' },
        bodyEncoding: HttpBodyEncoding.FORM,
        redirect: 'error',
        timeoutMs: configuration.requestTimeoutMs,
      });
    });

    it('reports the OAuth error code returned by a failed exchange', async () => {
      const client = new OpenAIAuthenticationClient(configuration, {
        get: vi.fn(),
        post: vi.fn(async () => ({ ok: false, status: 400, headers: new Headers(), body: { error: 'invalid_grant' } })),
      });

      const failure = await client.exchangeToken({}).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(OpenAIOAuthError);
      expect(failure).toMatchObject({ code: 'invalid_grant', message: 'OAuth 400: invalid_grant.' });
    });

    it('reports a generic code when a failed exchange has no OAuth error', async () => {
      const client = new OpenAIAuthenticationClient(configuration, {
        get: vi.fn(),
        post: vi.fn(async () => ({ ok: false, status: 502, headers: new Headers(), body: { error: 7 } })),
      });

      await expect(client.exchangeToken({})).rejects.toMatchObject({
        code: 'token_exchange_failed',
        message: 'OAuth 502: token_exchange_failed.',
      });
    });

    it('rejects responses that are not objects', async () => {
      const client = new OpenAIAuthenticationClient(configuration, {
        get: vi.fn(),
        post: vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: 'text' })),
      });

      await expect(client.exchangeToken({})).rejects.toThrow(ProtocolError);
    });
  });

  describe(OpenAIAuthenticationClient.prototype.refresh, () => {
    it('requires saved tokens', async () => {
      const client = new OpenAIAuthenticationClient(configuration, http());

      await expect(client.refresh({ clientId: 'client', subject: 'subject', email: 'e' })).rejects.toThrow(
        new AuthenticationError('Sign in again.'),
      );
    });

    it('exchanges the refresh token and keeps omitted credentials', async () => {
      const post = vi.fn<HttpClient['post']>(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { access_token: 'next', token_type: 'Bearer', expires_in: 60 },
      }));
      const client = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post });
      const signal = new AbortController().signal;

      const tokens = await client.refresh(
        {
          clientId: 'client',
          subject: 'subject',
          email: 'e',
          tokens: { accessToken: 'old', refreshToken: 'refresh', idToken: 'id', expiresAt: 0, scopes: ['plan'] },
        },
        signal,
      );

      expect(tokens).toMatchObject({ accessToken: 'next', refreshToken: 'refresh', idToken: 'id', scopes: ['plan'] });
      expect(post).toHaveBeenCalledWith(expect.any(String), {
        body: {
          grant_type: 'refresh_token',
          client_id: 'client',
          refresh_token: 'refresh',
          resource: configuration.resource,
        },
        bodyEncoding: HttpBodyEncoding.FORM,
        redirect: 'error',
        signal,
        timeoutMs: configuration.requestTimeoutMs,
      });
    });

    it('verifies a returned ID token against the saved identity', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const token = await idToken(privateKey, {}, { audience: 'client', subject: 'intruder' });
      const client = new OpenAIAuthenticationClient(
        configuration,
        {
          get: vi.fn(),
          post: vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            body: { access_token: 'next', token_type: 'Bearer', expires_in: 60, id_token: token },
          })),
        },
        async () => publicKey,
      );

      await expect(
        client.refresh({
          clientId: 'client',
          subject: 'subject',
          email: 'e',
          tokens: { accessToken: 'old', refreshToken: 'refresh', idToken: 'id', expiresAt: 0, scopes: ['plan'] },
        }),
      ).rejects.toThrow('The signed-in identity does not match this saved account.');
    });

    it('accepts a returned ID token for the saved identity', async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const token = await idToken(privateKey, {}, { audience: 'client', subject: 'subject' });
      const client = new OpenAIAuthenticationClient(
        configuration,
        {
          get: vi.fn(),
          post: vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            body: { access_token: 'next', token_type: 'Bearer', expires_in: 60, id_token: token },
          })),
        },
        async () => publicKey,
      );

      await expect(
        client.refresh({
          clientId: 'client',
          subject: 'subject',
          email: 'e',
          tokens: { accessToken: 'old', refreshToken: 'refresh', idToken: 'id', expiresAt: 0, scopes: ['plan'] },
        }),
      ).resolves.toMatchObject({ accessToken: 'next', idToken: token });
    });
  });

  describe(OpenAIAuthenticationClient.prototype.revoke, () => {
    function signedIn() {
      return {
        clientId: 'client',
        subject: 'subject',
        email: 'e',
        tokens: { accessToken: 'access', refreshToken: 'refresh', idToken: 'id', expiresAt: 0, scopes: ['plan'] },
      };
    }

    function discovery(revocationEndpoint: unknown) {
      return vi.fn<HttpClient['get']>(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { revocation_endpoint: revocationEndpoint },
      }));
    }

    it('succeeds without a request when the account is signed out', async () => {
      const client = new OpenAIAuthenticationClient(configuration, http());

      await expect(client.revoke({ clientId: 'client', subject: 'subject', email: 'e' })).resolves.toBe(true);
    });

    it('revokes the refresh token at the discovered endpoint', async () => {
      const get = discovery(`${configuration.issuer}/oauth/revoke`);
      const post = vi.fn<HttpClient['post']>(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: undefined,
      }));
      const client = new OpenAIAuthenticationClient(configuration, { get, post });
      const signal = new AbortController().signal;

      await expect(client.revoke(signedIn(), signal)).resolves.toBe(true);
      expect(get).toHaveBeenCalledWith(`${configuration.issuer}/.well-known/openid-configuration`, {
        redirect: 'error',
        signal,
        timeoutMs: 10_000,
      });
      expect(post).toHaveBeenCalledWith(new URL(`${configuration.issuer}/oauth/revoke`), {
        body: { token: 'refresh', token_type_hint: 'refresh_token', client_id: 'client' },
        bodyEncoding: HttpBodyEncoding.FORM,
        responseBody: HttpResponseBody.NONE,
        redirect: 'error',
        signal,
        timeoutMs: 10_000,
      });
    });

    it('reports failure when discovery fails', async () => {
      const post = vi.fn<HttpClient['post']>();
      const client = new OpenAIAuthenticationClient(configuration, {
        get: vi.fn(async () => ({ ok: false, status: 503, headers: new Headers(), body: {} })),
        post,
      });

      await expect(client.revoke(signedIn())).resolves.toBe(false);
      expect(post).not.toHaveBeenCalled();
    });

    it.each([
      ['another origin', 'https://evil.example.test/revoke'],
      ['no endpoint', undefined],
    ])('reports failure when discovery advertises %s', async (_case, endpoint) => {
      const post = vi.fn<HttpClient['post']>();
      const client = new OpenAIAuthenticationClient(configuration, { get: discovery(endpoint), post });

      await expect(client.revoke(signedIn())).resolves.toBe(false);
      expect(post).not.toHaveBeenCalled();
    });

    it('reports failure without retrying when the server rejects the request', async () => {
      const post = vi.fn<HttpClient['post']>(async () => ({
        ok: false,
        status: 400,
        headers: new Headers(),
        body: undefined,
      }));
      const client = new OpenAIAuthenticationClient(configuration, {
        get: discovery(`${configuration.issuer}/oauth/revoke`),
        post,
      });

      await expect(client.revoke(signedIn())).resolves.toBe(false);
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('retries once after a server error and reports failure if it persists', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const post = vi.fn<HttpClient['post']>(async () => ({
        ok: false,
        status: 503,
        headers: new Headers(),
        body: undefined,
      }));
      const client = new OpenAIAuthenticationClient(configuration, {
        get: discovery(`${configuration.issuer}/oauth/revoke`),
        post,
      });

      const revoked = client.revoke(signedIn());
      await vi.advanceTimersByTimeAsync(500);

      await expect(revoked).resolves.toBe(false);
      expect(post).toHaveBeenCalledTimes(2);
    });

    it('retries once after a transport failure and succeeds', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const post = vi
        .fn<HttpClient['post']>()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ ok: true, status: 200, headers: new Headers(), body: undefined });
      const client = new OpenAIAuthenticationClient(configuration, {
        get: discovery(`${configuration.issuer}/oauth/revoke`),
        post,
      });

      const revoked = client.revoke(signedIn());
      await vi.advanceTimersByTimeAsync(500);

      await expect(revoked).resolves.toBe(true);
      expect(post).toHaveBeenCalledTimes(2);
    });
  });
});
