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
  it('[review-04] uses replacement sign-in credentials in an already-created chat provider', async () => {
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
      signIn: vi.fn(async (_existing, _consent, authorize) => {
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
    expect(models.list).toHaveBeenCalledWith('secret-access-token');
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
});
