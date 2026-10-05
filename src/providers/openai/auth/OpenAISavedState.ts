import type { OpenAIAccount } from './OpenAIAccount.ts';

export interface OpenAISavedState {
  version: 1;
  hostId: string;
  accounts: OpenAIAccount[];
}
