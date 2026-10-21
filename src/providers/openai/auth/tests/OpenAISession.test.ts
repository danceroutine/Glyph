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

  describe(OpenAISession.prototype.signIn, () => {
    it('requires an authorization handler', async () => {
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      const signIn = vi.spyOn(authentication, 'signIn');
      const session = new OpenAISession(store(account()), authentication, configuration);

      await expect(session.signIn()).rejects.toThrow('An authorization handler is required to sign in.');
      expect(signIn).not.toHaveBeenCalled();
    });

    it('registers a new account, persists it, and redacts its credentials', async () => {
      const savedStore = store(account());
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      const signal = new AbortController().signal;
      const authorize = vi.fn();
      vi.spyOn(authentication, 'signIn').mockResolvedValue({
        clientId: 'new-client',
        subject: 'new-subject',
        email: 'new@example.com',
        tokens: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          idToken: 'new-id',
          expiresAt: Number.MAX_SAFE_INTEGER,
          scopes: ['plan'],
        },
      });
      const session = new OpenAISession(savedStore, authentication, configuration, signal);

      const signedIn = await session.signIn(undefined, true, authorize);

      expect(authentication.signIn).toHaveBeenCalledWith('urn:uuid:test', undefined, true, signal, authorize);
      expect(signedIn).toMatchObject({ clientId: 'new-client', subject: 'new-subject', planNoticeSeen: false });
      expect(savedStore.state.accounts).toHaveLength(2);
      expect(savedStore.state.accounts[1]).toBe(signedIn);
      expect(savedStore.save).toHaveBeenCalledOnce();
      expect(session.redact('new-access new-refresh new-id')).toBe('[REDACTED] [REDACTED] [REDACTED]');
    });

    it('replaces a reauthorized account and keeps its notice acknowledgement', async () => {
      const existing = { ...account(), planNoticeSeen: true };
      const savedStore = store(existing);
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      vi.spyOn(authentication, 'signIn').mockResolvedValue({
        clientId: existing.clientId,
        subject: existing.subject,
        email: existing.email,
        tokens: { ...existing.tokens!, accessToken: 'reauthorized' },
      });
      const session = new OpenAISession(savedStore, authentication, configuration);

      const signedIn = await session.signIn(existing, false, vi.fn());

      expect(savedStore.state.accounts).toEqual([signedIn]);
      expect(signedIn).toMatchObject({ planNoticeSeen: true, tokens: { accessToken: 'reauthorized' } });
    });
  });

  describe(OpenAISession.prototype.redact, () => {
    it('redacts JSON web tokens and skips signed-out accounts', () => {
      const savedStore = store({ clientId: 'client', subject: 'subject', email: 'developer@example.com' });
      const session = new OpenAISession(
        savedStore,
        new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() }),
        configuration,
      );

      expect(session.redact('token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl end')).toBe('token [REDACTED JWT] end');
    });
  });

  describe(OpenAISession.prototype.accessToken, () => {
    it('returns unexpired saved credentials without refreshing or saving', async () => {
      const saved = account();
      const savedStore = store(saved);
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      const refresh = vi.spyOn(authentication, 'refresh');
      const session = new OpenAISession(savedStore, authentication, configuration);

      await expect(session.accessToken(saved)).resolves.toBe('access-secret');
      expect(refresh).not.toHaveBeenCalled();
      expect(savedStore.save).not.toHaveBeenCalled();
    });

    it('rejects signed-out accounts', async () => {
      const saved = { clientId: 'client', subject: 'subject', email: 'developer@example.com' };
      const session = new OpenAISession(
        store(saved),
        new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() }),
        configuration,
      );

      await expect(session.accessToken(saved)).rejects.toThrow(
        'This account is signed out. Use /login or restart to sign in.',
      );
    });

    it('refreshes expired credentials once a pending sign-in has been persisted', async () => {
      const savedStore = store(account());
      vi.spyOn(savedStore, 'save').mockRejectedValueOnce(new Error('disk unavailable'));
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      vi.spyOn(authentication, 'signIn').mockResolvedValue({
        ...account(0),
        subject: 'expired-subject',
        tokens: account(0).tokens!,
      });
      const refresh = vi
        .spyOn(authentication, 'refresh')
        .mockResolvedValue({ ...account().tokens!, accessToken: 'refreshed' });
      const session = new OpenAISession(savedStore, authentication, configuration);
      await expect(session.signIn(undefined, false, vi.fn())).rejects.toThrow('disk unavailable');
      const pendingAccount = savedStore.state.accounts[1]!;

      await expect(session.accessToken(pendingAccount)).resolves.toBe('refreshed');
      expect(refresh).toHaveBeenCalledOnce();
    });

    it('rejects when the account signs out while its pending sign-in is persisted', async () => {
      const savedStore = store(account());
      let finish!: () => void;
      vi.spyOn(savedStore, 'save')
        .mockRejectedValueOnce(new Error('disk unavailable'))
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finish = resolve;
            }),
        );
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      vi.spyOn(authentication, 'signIn').mockResolvedValue({
        ...account(),
        subject: 'pending-subject',
        tokens: account().tokens!,
      });
      const session = new OpenAISession(savedStore, authentication, configuration);
      await expect(session.signIn(undefined, false, vi.fn())).rejects.toThrow('disk unavailable');
      const pendingAccount = savedStore.state.accounts[1]!;

      const pending = session.accessToken(pendingAccount);
      await vi.waitFor(() => expect(savedStore.save).toHaveBeenCalledTimes(2));
      delete pendingAccount.tokens;
      finish();

      await expect(pending).rejects.toThrow(new AuthenticationError('This account is signed out.'));
    });

    it('rejects when the account is removed while its credentials are persisted', async () => {
      const savedStore = store(account());
      let finish!: () => void;
      vi.spyOn(savedStore, 'save')
        .mockRejectedValueOnce(new Error('disk unavailable'))
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              finish = resolve;
            }),
        );
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      vi.spyOn(authentication, 'signIn').mockResolvedValue({
        ...account(),
        subject: 'removed-subject',
        tokens: account().tokens!,
      });
      const session = new OpenAISession(savedStore, authentication, configuration);
      await expect(session.signIn(undefined, false, vi.fn())).rejects.toThrow('disk unavailable');
      const pendingAccount = savedStore.state.accounts[1]!;

      const pending = session.accessToken(pendingAccount);
      await vi.waitFor(() => expect(savedStore.save).toHaveBeenCalledTimes(2));
      savedStore.state.accounts.pop();
      finish();

      await expect(pending).rejects.toThrow('The account session changed during authentication.');
    });

    it('rejects refreshed credentials that no longer grant plan usage', async () => {
      const saved = account(0);
      const savedStore = store(saved);
      const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
      vi.spyOn(authentication, 'refresh').mockResolvedValue({
        ...saved.tokens!,
        accessToken: 'unplanned',
        expiresAt: Number.MAX_SAFE_INTEGER,
        scopes: ['openid'],
      });
      const session = new OpenAISession(savedStore, authentication, configuration);

      await expect(session.accessToken(saved)).rejects.toThrow(
        'ChatGPT plan usage is disabled. Use /login to enable it.',
      );
      expect(saved.tokens?.accessToken).toBe('unplanned');
      expect(savedStore.save).toHaveBeenCalledOnce();
    });
  });

  describe(OpenAISession.prototype.logout, () => {
    it('saves and confirms logout for an already signed-out account', async () => {
      const saved = { clientId: 'client', subject: 'subject', email: 'developer@example.com' };
      const savedStore = store(saved);
      const session = new OpenAISession(
        savedStore,
        new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() }),
        configuration,
      );

      await expect(session.logout(saved)).resolves.toBe(true);
      expect(savedStore.save).toHaveBeenCalledOnce();
    });

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
