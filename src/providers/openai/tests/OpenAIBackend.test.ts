import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider } from '#src/chat/ChatProvider.js';
import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import type { OpenAIAccount } from '#src/providers/openai/auth/OpenAIAccount.js';
import type { OpenAIAccountStore } from '#src/providers/openai/auth/OpenAIAccountStore.js';
import type { OpenAISavedState } from '#src/providers/openai/auth/OpenAISavedState.js';
import type { OpenAISessionService } from '#src/providers/openai/auth/OpenAISessionService.js';
import { OpenAIBackend } from '#src/providers/openai/OpenAIBackend.js';
import { OpenAISession } from '#src/providers/openai/auth/OpenAISession.js';
import { OpenAIAuthenticationClient } from '#src/providers/openai/auth/OpenAIAuthenticationClient.js';

const configuration = {
  issuer: 'https://auth.example.test',
  resource: 'https://api.example.test/v1',
  scopes: 'openid plan',
  planScope: 'plan',
  requestTimeoutMs: 30_000,
};

const openAIAccount: OpenAIAccount = {
  clientId: 'workspace-client',
  subject: 'user-subject',
  email: 'developer@example.com',
  tokens: {
    accessToken: 'secret-access-token',
    refreshToken: 'secret-refresh-token',
    idToken: 'secret-id-token',
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: ['plan'],
  },
};

describe(OpenAIBackend, () => {
  it('invalidates unfinished authentication before releasing the account store on shutdown', async () => {
    const account = structuredClone(openAIAccount);
    account.tokens!.expiresAt = 0;
    const store: OpenAIAccountStore = {
      state: { version: 1, hostId: 'host', accounts: [account] },
      acquire: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
    let finish!: () => void;
    vi.spyOn(authentication, 'refresh').mockImplementation(
      () =>
        new Promise(resolve => {
          finish = () => {
            resolve({ ...account.tokens!, accessToken: 'late' });
          };
        }),
    );
    const session = new OpenAISession(store, authentication, configuration);
    const backend = new OpenAIBackend(
      store,
      session,
      { list: vi.fn(async () => []) },
      { create: vi.fn() },
      configuration,
    );
    await backend.initialize();
    const pending = session.accessToken(account).catch((error: unknown) => error);
    await backend.dispose();
    expect(store.release).toHaveBeenCalledOnce();
    finish();
    expect(await pending).toBeInstanceOf(Error);
    expect(store.save).not.toHaveBeenCalled();
    expect(account.tokens?.accessToken).toBe('secret-access-token');
  });

  it('uses replacement sign-in credentials in an already-created chat provider', async () => {
    const original = structuredClone(openAIAccount);
    const state: OpenAISavedState = { version: 1, hostId: 'host', accounts: [original] };
    const store: OpenAIAccountStore = {
      state,
      acquire: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const authentication = new OpenAIAuthenticationClient(configuration, { get: vi.fn(), post: vi.fn() });
    vi.spyOn(authentication, 'signIn').mockResolvedValue({
      ...original,
      tokens: { ...original.tokens!, accessToken: 'replacement-access', refreshToken: 'replacement-refresh' },
    });
    const session = new OpenAISession(store, authentication, configuration);
    // Capture the exact credential callback cached by the real backend. No
    // provider HTTP or external identity service is involved in this regression.
    let credential!: () => Promise<string>;
    const providers = {
      create: (_model: string, token: () => Promise<string>): ChatProvider => {
        credential = token;
        return {} as ChatProvider;
      },
    };
    const backend = new OpenAIBackend(store, session, { list: vi.fn(async () => []) }, providers, configuration);
    await backend.initialize();
    try {
      const account = backend.accounts[0]!;
      backend.createProvider(account, { slug: 'model-a', name: 'Model A' });
      await expect(credential()).resolves.toBe('secret-access-token');
      await backend.signIn(account, { requestInferenceAccess: true }, async () => {});
      expect(store.state.accounts[0]?.tokens?.accessToken).toBe('replacement-access');
      await expect(credential()).resolves.toBe('replacement-access');
    } finally {
      await backend.dispose();
    }
  });

  it('contains OpenAI credentials and account records behind neutral account operations', async () => {
    const state: OpenAISavedState = { version: 1, hostId: 'host', accounts: [openAIAccount] };
    const store: OpenAIAccountStore = {
      state,
      acquire: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    };
    const session: OpenAISessionService = {
      dispose: vi.fn(async () => {}),
      signIn: vi.fn<OpenAISessionService['signIn']>(async (_existing, _consent, authorize) => {
        await authorize?.({ url: 'https://auth.example.test/authorize' });
        return openAIAccount;
      }),
      accessToken: vi.fn(async () => 'secret-access-token'),
      logout: vi.fn(async () => true),
      redact: message => message.replaceAll('secret-access-token', '[REDACTED]'),
    };
    const models = { list: vi.fn(async () => [{ slug: 'model-a', name: 'Model A' }]) };
    const provider = {} as ChatProvider;
    const providers = {
      create: vi.fn(
        (_model: string, _token: () => Promise<string>, _state?: ChatProviderState): ChatProvider => provider,
      ),
    };
    const backend = new OpenAIBackend(store, session, models, providers, configuration);

    await backend.initialize();
    const account = backend.accounts[0]!;
    expect(account).toMatchObject({
      provider: 'openai',
      label: 'developer@example.com',
      detail: 'workspace-client',
      connected: true,
      inferenceAccess: true,
    });
    expect(JSON.stringify(account)).not.toContain('secret-access-token');

    expect(await backend.listModels(account)).toEqual([{ slug: 'model-a', name: 'Model A' }]);
    expect(models.list).toHaveBeenCalledWith('secret-access-token', expect.any(AbortSignal));
    expect(backend.createProvider(account, { slug: 'model-a', name: 'Model A' })).toBe(provider);
    const credential = providers.create.mock.calls[0]?.[1];
    await expect(credential?.()).resolves.toBe('secret-access-token');

    const authorize = vi.fn();
    await backend.signIn(account, { requestInferenceAccess: true }, authorize);
    expect(session.signIn).toHaveBeenCalledWith(openAIAccount, true, expect.any(Function));
    expect(authorize).toHaveBeenCalledWith({
      url: 'https://auth.example.test/authorize',
      title: 'Continue with ChatGPT',
      message: 'Authorize Glyph to use your ChatGPT plan.',
    });

    await backend.dispose();
    expect(store.acquire).toHaveBeenCalledOnce();
    expect(store.load).toHaveBeenCalledOnce();
    expect(store.release).toHaveBeenCalledOnce();
  });

  describe(OpenAIBackend.prototype.initialize, () => {
    it('acquires and loads the store only once', async () => {
      const store = fakeStore([]);
      const backend = new OpenAIBackend(store, fakeSession(), { list: vi.fn() }, { create: vi.fn() }, configuration);

      await backend.initialize();
      await backend.initialize();

      expect(store.acquire).toHaveBeenCalledOnce();
      expect(store.load).toHaveBeenCalledOnce();
    });

    it('releases the store and rethrows when loading fails', async () => {
      const store = fakeStore([]);
      const failure = new Error('corrupt');
      vi.mocked(store.load).mockRejectedValueOnce(failure);
      const backend = new OpenAIBackend(store, fakeSession(), { list: vi.fn() }, { create: vi.fn() }, configuration);

      await expect(backend.initialize()).rejects.toBe(failure);
      expect(store.release).toHaveBeenCalledOnce();
      await backend.initialize();
      expect(store.acquire).toHaveBeenCalledTimes(2);
    });

    it('reports both failures when cleanup after a failed load also fails', async () => {
      const store = fakeStore([]);
      const failure = new Error('corrupt');
      const cleanupFailure = new Error('unlock failed');
      vi.mocked(store.load).mockRejectedValueOnce(failure);
      vi.mocked(store.release).mockRejectedValueOnce(cleanupFailure);
      const backend = new OpenAIBackend(store, fakeSession(), { list: vi.fn() }, { create: vi.fn() }, configuration);

      const error = await backend.initialize().catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        message: 'Account initialization failed and cleanup was incomplete.',
        errors: [failure, cleanupFailure],
      });
    });
  });

  describe(OpenAIBackend.prototype.dispose, () => {
    it('does not release a store it never acquired', async () => {
      const store = fakeStore([]);
      const session = fakeSession();
      const backend = new OpenAIBackend(store, session, { list: vi.fn() }, { create: vi.fn() }, configuration);

      await backend.dispose();

      expect(session.dispose).not.toHaveBeenCalled();
      expect(store.release).not.toHaveBeenCalled();
    });
  });

  describe(OpenAIBackend.prototype.signIn, () => {
    it('signs in a new account without inference access or a browser handler by default', async () => {
      const session = fakeSession();
      const backend = new OpenAIBackend(fakeStore([]), session, { list: vi.fn() }, { create: vi.fn() }, configuration);

      const account = await backend.signIn();

      expect(session.signIn).toHaveBeenCalledWith(undefined, false, undefined);
      expect(account).toMatchObject({ provider: 'openai', label: 'developer@example.com' });
    });
  });

  describe(OpenAIBackend.prototype.acknowledgeNotice, () => {
    it('records the plan notice once and stops presenting it', async () => {
      const saved = structuredClone(openAIAccount);
      const store = fakeStore([saved]);
      const backend = new OpenAIBackend(store, fakeSession(), { list: vi.fn() }, { create: vi.fn() }, configuration);
      const account = backend.accounts[0]!;
      expect(account.notice).toEqual({
        message:
          "You're using your ChatGPT plan. Manage this app's plan allowance and credit access at https://chatgpt.com/settings/usage",
        acknowledgementPrompt: 'Got it [Enter]: ',
        url: 'https://chatgpt.com/settings/usage',
      });

      await backend.acknowledgeNotice(account);
      await backend.acknowledgeNotice(account);

      expect(saved.planNoticeSeen).toBe(true);
      expect(store.save).toHaveBeenCalledOnce();
      expect(backend.accounts[0]).not.toHaveProperty('notice');
    });
  });

  describe(OpenAIBackend.prototype.listModels, () => {
    it('rejects accounts without plan inference access', async () => {
      const saved = structuredClone(openAIAccount);
      delete saved.tokens;
      const models = { list: vi.fn() };
      const backend = new OpenAIBackend(fakeStore([saved]), fakeSession(), models, { create: vi.fn() }, configuration);
      const account = backend.accounts[0]!;

      expect(account).toMatchObject({ connected: false, inferenceAccess: false });
      await expect(backend.listModels(account)).rejects.toThrow(
        'Sign-in completed, but ChatGPT plan usage was not granted.',
      );
      expect(models.list).not.toHaveBeenCalled();
    });

    it('honors caller cancellation and the shared store lifetime', async () => {
      const store = { ...fakeStore([structuredClone(openAIAccount)]), lifetimeSignal: new AbortController().signal };
      const models = {
        list: vi.fn(async (_token: string, _signal?: AbortSignal) => [{ slug: 'model-a', name: 'Model A' }]),
      };
      const backend = new OpenAIBackend(store, fakeSession(), models, { create: vi.fn() }, configuration);
      const account = backend.accounts[0]!;
      const cancellation = new AbortController();

      await expect(backend.listModels(account, cancellation.signal)).resolves.toEqual([
        { slug: 'model-a', name: 'Model A' },
      ]);
      const signal = models.list.mock.calls[0]![1]!;
      expect(signal.aborted).toBe(false);
      cancellation.abort(new Error('Stopped'));
      expect(signal.aborted).toBe(true);
    });

    it('stops waiting for credentials when cancelled', async () => {
      const session = fakeSession();
      vi.mocked(session.accessToken).mockReturnValue(new Promise(() => {}));
      const models = { list: vi.fn() };
      const backend = new OpenAIBackend(
        fakeStore([structuredClone(openAIAccount)]),
        session,
        models,
        { create: vi.fn() },
        configuration,
      );
      const account = backend.accounts[0]!;
      const cancellation = new AbortController();
      const reason = new Error('Stopped');

      const pending = backend.listModels(account, cancellation.signal);
      await vi.waitFor(() => {
        expect(session.accessToken).toHaveBeenCalled();
      });
      cancellation.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(models.list).not.toHaveBeenCalled();
    });

    it('rejects immediately once the backend has been disposed', async () => {
      const session = fakeSession();
      const backend = new OpenAIBackend(
        fakeStore([structuredClone(openAIAccount)]),
        session,
        { list: vi.fn() },
        { create: vi.fn() },
        configuration,
      );
      const account = backend.accounts[0]!;
      await backend.dispose();

      await expect(backend.listModels(account)).rejects.toThrow('Model discovery stopped with its backend.');
      expect(session.accessToken).not.toHaveBeenCalled();
    });
  });

  describe(OpenAIBackend.prototype.createProvider, () => {
    it('restores providers from saved state', () => {
      const provider = {} as ChatProvider;
      const providers = { create: vi.fn((): ChatProvider => provider) };
      const backend = new OpenAIBackend(
        fakeStore([structuredClone(openAIAccount)]),
        fakeSession(),
        { list: vi.fn() },
        providers,
        configuration,
      );
      const state = { version: 1 } as unknown as ChatProviderState;

      expect(backend.createProvider(backend.accounts[0]!, { slug: 'model-a', name: 'Model A' }, state)).toBe(provider);
      expect(providers.create).toHaveBeenCalledWith('model-a', expect.any(Function), state);
    });

    it.each([
      ['another provider', { provider: 'other' }, 'This account belongs to another provider.'],
      ['an unregistered account', { id: 'missing' }, 'This account is no longer registered.'],
    ])('rejects %s', (_case, override, message) => {
      const backend = new OpenAIBackend(
        fakeStore([structuredClone(openAIAccount)]),
        fakeSession(),
        { list: vi.fn() },
        { create: vi.fn() },
        configuration,
      );

      expect(() =>
        backend.createProvider({ ...backend.accounts[0]!, ...override }, { slug: 'model-a', name: 'Model A' }),
      ).toThrow(message);
    });
  });

  describe(OpenAIBackend.prototype.logout, () => {
    it('logs out the registered account', async () => {
      const saved = structuredClone(openAIAccount);
      const session = fakeSession();
      const backend = new OpenAIBackend(
        fakeStore([saved]),
        session,
        { list: vi.fn() },
        { create: vi.fn() },
        configuration,
      );

      await expect(backend.logout(backend.accounts[0]!)).resolves.toBe(true);
      expect(session.logout).toHaveBeenCalledWith(saved);
    });
  });

  describe(OpenAIBackend.prototype.redact, () => {
    it('delegates redaction to the session', () => {
      const backend = new OpenAIBackend(
        fakeStore([]),
        fakeSession(),
        { list: vi.fn() },
        { create: vi.fn() },
        configuration,
      );

      expect(backend.redact('token secret-access-token')).toBe('token [REDACTED]');
    });
  });
});

function fakeStore(accounts: OpenAIAccount[]): OpenAIAccountStore {
  return {
    state: { version: 1, hostId: 'host', accounts },
    acquire: vi.fn(async () => {}),
    load: vi.fn(async () => {}),
    save: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
}

function fakeSession(): OpenAISessionService {
  return {
    dispose: vi.fn(async () => {}),
    signIn: vi.fn(async () => structuredClone(openAIAccount)),
    accessToken: vi.fn(async () => 'secret-access-token'),
    logout: vi.fn(async () => true),
    redact: message => message.replaceAll('secret-access-token', '[REDACTED]'),
  };
}
