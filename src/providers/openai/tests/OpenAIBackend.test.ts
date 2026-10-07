import { describe, expect, it, vi } from 'vitest';
import type { ChatProvider } from '../../../chat/ChatProvider.ts';
import type { ChatProviderState } from '../../../chat/ChatProviderState.ts';
import type { OpenAIAccount } from '../auth/OpenAIAccount.ts';
import type { OpenAIAccountStore } from '../auth/OpenAIAccountStore.ts';
import type { OpenAISavedState } from '../auth/OpenAISavedState.ts';
import type { OpenAISessionService } from '../auth/OpenAISessionService.ts';
import { OpenAIBackend } from '../OpenAIBackend.ts';

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
