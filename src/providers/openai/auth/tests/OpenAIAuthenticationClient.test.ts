import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from '../../../../errors/AuthenticationError.ts';
import type { HttpClient } from '../../../../http/HttpClient.ts';
import type { OpenAIConfiguration } from '../../OpenAIConfiguration.ts';
import { OpenAIAuthenticationClient } from '../OpenAIAuthenticationClient.ts';

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

describe(OpenAIAuthenticationClient, () => {
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
  });

  describe(OpenAIAuthenticationClient.prototype.validateAuthorizationCallback, () => {
    it('rejects a callback whose state does not match the authorization attempt', () => {
      const client = new OpenAIAuthenticationClient(configuration, http());
      const attempt = client.createAuthorizationAttempt('urn:uuid:host', 'http://127.0.0.1/callback', 'client');
      const callback = new URL(`http://127.0.0.1/callback?state=wrong&code=code&client_id=client`);

      expect(() => client.validateAuthorizationCallback(callback, attempt)).toThrow(AuthenticationError);
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
  });
});
