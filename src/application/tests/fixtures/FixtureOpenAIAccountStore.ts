import type { OpenAIAccountStore } from '../../../providers/openai/auth/OpenAIAccountStore.ts';
import type { OpenAISavedState } from '../../../providers/openai/auth/OpenAISavedState.ts';

export class FixtureOpenAIAccountStore implements OpenAIAccountStore {
  readonly state: OpenAISavedState = {
    version: 1,
    hostId: 'urn:uuid:00000000-0000-0000-0000-000000000000',
    accounts: [
      {
        clientId: 'fixture-client',
        subject: 'fixture-subject',
        email: 'fixture@example.invalid',
        planNoticeSeen: true,
        tokens: {
          accessToken: 'sentinel-not-a-real-token',
          refreshToken: 'sentinel-not-a-real-refresh-token',
          idToken: 'sentinel-not-a-real-id-token',
          expiresAt: Number.MAX_SAFE_INTEGER,
          scopes: ['chatgpt.tokens.use.direct'],
        },
      },
    ],
  };

  async acquire(): Promise<void> {}
  async load(): Promise<void> {}
  async save(): Promise<void> {}
  async release(): Promise<void> {}
}
