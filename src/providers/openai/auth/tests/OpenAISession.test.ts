import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from '../../../../errors/AuthenticationError.ts';
import type { HttpClient } from '../../../../http/HttpClient.ts';
import type { OpenAIConfiguration } from '../../OpenAIConfiguration.ts';
import type { OpenAIAccount } from '../OpenAIAccount.ts';
import type { OpenAIAccountStore } from '../OpenAIAccountStore.ts';
import { OpenAIAuthenticationClient } from '../OpenAIAuthenticationClient.ts';
import type { OpenAISavedState } from '../OpenAISavedState.ts';
import { OpenAISession } from '../OpenAISession.ts';

const configuration: OpenAIConfiguration = {
  issuer: 'https://auth.example.test',
  resource: 'https://api.example.test/v1',
  scopes: 'openid plan',
  planScope: 'plan',
  requestTimeoutMs: 30_000,
};

function account(expiresAt = Number.MAX_SAFE_INTEGER): OpenAIAccount {
  return {
    clientId: 'client',
    subject: 'subject',
    email: 'developer@example.com',
    tokens: {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      idToken: 'id-secret',
      expiresAt,
      scopes: ['openid', configuration.planScope],
    },
  };
}

function store(saved: OpenAIAccount): OpenAIAccountStore {
  const state: OpenAISavedState = { version: 1, hostId: 'urn:uuid:test', accounts: [saved] };
  return {
    state,
    acquire: vi.fn(async () => {}),
    load: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
}

describe(OpenAISession, () => {
  describe(OpenAISession.prototype.accessToken, () => {
    it('blocks inference when plan consent is absent and redacts known secrets', async () => {
      const saved = account();
      saved.tokens!.scopes = ['openid'];
      const session = new OpenAISession(
        store(saved),
        new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() }),
        configuration,
      );

      await expect(session.accessToken(saved)).rejects.toBeInstanceOf(AuthenticationError);
      expect(session.redact('access-secret refresh-secret id-secret')).toBe('[REDACTED] [REDACTED] [REDACTED]');
    });

    it('serializes refresh, rotates credentials, and persists them', async () => {
      const saved = account(0);
      const savedStore = store(saved);
      const post = vi.fn<HttpClient['post']>(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { access_token: 'next-access', refresh_token: 'next-refresh', token_type: 'Bearer', expires_in: 3600 },
      }));
      const session = new OpenAISession(
        savedStore,
        new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post }),
        configuration,
      );

      expect(await Promise.all([session.accessToken(saved), session.accessToken(saved)])).toEqual([
        'next-access',
        'next-access',
      ]);
      expect(post).toHaveBeenCalledOnce();
      expect(saved.tokens?.refreshToken).toBe('next-refresh');
      expect(savedStore.save).toHaveBeenCalledOnce();
    });

    it('clears renewable credentials when the authorization server rejects a refresh permanently', async () => {
      const saved = account(0);
      const savedStore = store(saved);
      const session = new OpenAISession(
        savedStore,
        new OpenAIAuthenticationClient(configuration, {
          get: vi.fn(),
          post: vi.fn(async () => ({
            ok: false,
            status: 400,
            headers: new Headers(),
            body: { error: 'invalid_grant' },
          })),
        }),
        configuration,
      );

      await expect(session.accessToken(saved)).rejects.toThrow(/expired or was revoked/);
      expect(saved.tokens).toBeUndefined();
      expect(savedStore.save).toHaveBeenCalledOnce();
    });
  });

  describe(OpenAISession.prototype.logout, () => {
    it('clears local tokens when remote revocation cannot be confirmed', async () => {
      const saved = account();
      const savedStore = store(saved);
      const session = new OpenAISession(
        savedStore,
        new OpenAIAuthenticationClient(configuration, {
          get: vi.fn(async () => ({ ok: false, status: 503, headers: new Headers(), body: {} })),
          post: vi.fn(),
        }),
        configuration,
      );

      expect(await session.logout(saved)).toBe(false);
      expect(saved.tokens).toBeUndefined();
      expect(savedStore.save).toHaveBeenCalledOnce();
    });
  });
});
