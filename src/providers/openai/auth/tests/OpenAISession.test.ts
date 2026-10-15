import { describe, expect, it, vi } from 'vitest';
import { AuthenticationError } from '#src/errors/AuthenticationError.js';
import type { HttpClient } from '#src/http/HttpClient.js';
import type { OpenAIConfiguration } from '#src/providers/openai/OpenAIConfiguration.js';
import type { OpenAIAccount } from '#src/providers/openai/auth/OpenAIAccount.js';
import type { OpenAIAccountStore } from '#src/providers/openai/auth/OpenAIAccountStore.js';
import { OpenAIAuthenticationClient } from '#src/providers/openai/auth/OpenAIAuthenticationClient.js';
import type { OpenAISavedState } from '#src/providers/openai/auth/OpenAISavedState.js';
import { OpenAISession } from '#src/providers/openai/auth/OpenAISession.js';
import { OpenAIAccountService } from '#src/providers/openai/auth/OpenAIAccountService.js';

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
  it('invalidates shared refresh completion when the account owner shuts down', async () => {
    const saved = account(0);
    const savedStore = store(saved);
    const accounts = new OpenAIAccountService(savedStore);
    await accounts.initialize();
    const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
    let finish!: () => void;
    vi.spyOn(authentication, 'refresh').mockImplementation(
      () =>
        new Promise(resolve => {
          finish = () => resolve({ ...saved.tokens!, accessToken: 'late', refreshToken: 'late-refresh' });
        }),
    );
    const session = new OpenAISession(accounts.borrowStore(), authentication, configuration);
    const pending = session.accessToken(saved).catch(error => error);
    await accounts.dispose();
    finish();
    expect(await pending).toBeInstanceOf(AuthenticationError);
    expect(saved.tokens?.accessToken).toBe('access-secret');
    expect(savedStore.save).not.toHaveBeenCalled();
    expect(savedStore.release).toHaveBeenCalledOnce();
    await session.dispose();
  });

  it('drains shared credential persistence before releasing the owner’s lock', async () => {
    const saved = account(0);
    const savedStore = store(saved);
    const accounts = new OpenAIAccountService(savedStore);
    await accounts.initialize();
    let finish!: () => void;
    vi.spyOn(savedStore, 'save').mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
    vi.spyOn(authentication, 'refresh').mockResolvedValue({ ...saved.tokens!, accessToken: 'rotated' });
    const session = new OpenAISession(accounts.borrowStore(), authentication, configuration);
    const pending = session.accessToken(saved).catch(error => error);
    await vi.waitFor(() => expect(savedStore.save).toHaveBeenCalledOnce());
    const disposing = accounts.dispose();
    await Promise.resolve();
    expect(savedStore.release).not.toHaveBeenCalled();
    finish();
    await disposing;
    expect(await pending).toBeInstanceOf(AuthenticationError);
    expect(savedStore.release).toHaveBeenCalledOnce();
    await session.dispose();
  });

  it.each(['initiator', 'peer'] as const)(
    'keeps shared account refresh alive when its %s workspace is disposed',
    async disposedWorkspace => {
      const saved = account(0);
      const savedStore = store(saved);
      const accounts = new OpenAIAccountService(savedStore);
      await accounts.initialize();
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      let finish!: () => void;
      const refresh = vi.spyOn(authentication, 'refresh').mockImplementation(
        () =>
          new Promise(resolve => {
            finish = () =>
              resolve({
                ...saved.tokens!,
                accessToken: 'rotated',
                refreshToken: 'rotated-refresh',
                expiresAt: Number.MAX_SAFE_INTEGER,
              });
          }),
      );
      const first = new OpenAISession(accounts.borrowStore(), authentication, configuration);
      const second = new OpenAISession(accounts.borrowStore(), authentication, configuration);
      const requests = [
        first.accessToken(saved).catch(error => error),
        second.accessToken(saved).catch(error => error),
      ];
      const disposed = disposedWorkspace === 'initiator' ? first : second;
      await disposed.dispose();
      finish();
      const results = await Promise.all(requests);
      expect(results[disposedWorkspace === 'initiator' ? 1 : 0]).toBe('rotated');
      expect(results[disposedWorkspace === 'initiator' ? 0 : 1]).toBeInstanceOf(AuthenticationError);
      expect(saved.tokens?.refreshToken).toBe('rotated-refresh');
      expect(refresh).toHaveBeenCalledOnce();
      expect(savedStore.save).toHaveBeenCalledOnce();
      await first.dispose();
      await second.dispose();
      await accounts.dispose();
    },
  );

  it('drains an already-started credential write before session disposal finishes', async () => {
    const saved = account(0);
    const savedStore = store(saved);
    let finish!: () => void;
    vi.spyOn(savedStore, 'save').mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
    vi.spyOn(authentication, 'refresh').mockResolvedValue({ ...saved.tokens!, accessToken: 'rotated' });
    const session = new OpenAISession(savedStore, authentication, configuration);
    const pending = session.accessToken(saved).catch(error => error);
    await vi.waitFor(() => expect(savedStore.save).toHaveBeenCalledOnce());
    let disposed = false;
    const disposing = session.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    finish();
    await disposing;
    expect(await pending).toBeInstanceOf(AuthenticationError);
    await expect(session.accessToken(saved)).rejects.toThrow('stopped');
  });

  it('discards a refresh completed after logout instead of restoring signed-out credentials', async () => {
    const saved = account(0);
    const savedStore = store(saved);
    const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
    let finish!: () => void;
    const tokens = { ...saved.tokens!, accessToken: 'late-refresh' };
    vi.spyOn(authentication, 'refresh').mockImplementation(
      () =>
        new Promise(resolve => {
          finish = () => resolve(tokens);
        }),
    );
    vi.spyOn(authentication, 'revoke').mockResolvedValue(true);
    const session = new OpenAISession(savedStore, authentication, configuration);
    const pending = session.accessToken(saved).catch(error => error);
    await session.logout(saved);
    finish();
    expect(await pending).toBeInstanceOf(AuthenticationError);
    expect(saved.tokens).toBeUndefined();
    expect(savedStore.save).toHaveBeenCalledTimes(1);
  });

  describe(OpenAISession.prototype.accessToken, () => {
    it('retries saving rotated credentials before allowing another workspace to reuse them', async () => {
      const saved = account(0);
      const savedStore = store(saved);
      const save = vi
        .spyOn(savedStore, 'save')
        .mockRejectedValueOnce(new Error('disk unavailable'))
        .mockRejectedValueOnce(new Error('disk still unavailable'));
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      const refresh = vi
        .spyOn(authentication, 'refresh')
        .mockResolvedValue({ ...saved.tokens!, accessToken: 'rotated', expiresAt: Number.MAX_SAFE_INTEGER });
      const first = new OpenAISession(savedStore, authentication, configuration);
      await expect(first.accessToken(saved)).rejects.toThrow('disk unavailable');
      const second = new OpenAISession(savedStore, authentication, configuration);
      await expect(second.accessToken(saved)).rejects.toThrow('disk still unavailable');
      await expect(second.accessToken(saved)).resolves.toBe('rotated');
      expect(save).toHaveBeenCalledTimes(3);
      expect(refresh).toHaveBeenCalledOnce();
    });

    it('returns each account’s own token when different accounts refresh concurrently', async () => {
      const first = account(0);
      const second = { ...account(0), subject: 'second-subject' };
      const savedStore = store(first);
      savedStore.state.accounts.push(second);
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const refresh = vi.spyOn(authentication, 'refresh').mockImplementation(async value => {
        await gate;
        return { ...value.tokens!, accessToken: `refreshed-${value.subject}`, expiresAt: Number.MAX_SAFE_INTEGER };
      });
      const session = new OpenAISession(savedStore, authentication, configuration);
      const requests = [session.accessToken(first), session.accessToken(second)];
      release();
      const tokens = await Promise.all(requests);
      expect(tokens).toEqual(['refreshed-subject', 'refreshed-second-subject']);
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('coalesces refreshes of the same shared account across workspace sessions', async () => {
      const saved = account(0);
      const accounts = new OpenAIAccountService(store(saved));
      await accounts.initialize();
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      const otherAuthentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const refresh = vi.fn(async () => {
        await gate;
        return {
          ...saved.tokens!,
          accessToken: 'rotated-access',
          refreshToken: 'rotated-refresh',
          expiresAt: Number.MAX_SAFE_INTEGER,
        };
      });
      vi.spyOn(authentication, 'refresh').mockImplementation(refresh);
      vi.spyOn(otherAuthentication, 'refresh').mockImplementation(refresh);
      try {
        const first = new OpenAISession(accounts.borrowStore(), authentication, configuration);
        const second = new OpenAISession(accounts.borrowStore(), otherAuthentication, configuration);
        const requests = [first.accessToken(saved), second.accessToken(saved)];
        release();
        await expect(Promise.all(requests)).resolves.toEqual(['rotated-access', 'rotated-access']);
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        release();
        await accounts.dispose();
      }
    });

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
