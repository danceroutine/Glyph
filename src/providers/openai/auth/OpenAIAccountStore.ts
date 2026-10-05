import type { OpenAISavedState } from './OpenAISavedState.ts';

/** Persists OpenAI account registrations and coordinates exclusive credential access. */
export interface OpenAIAccountStore {
  readonly state: OpenAISavedState;
  acquire(): Promise<void>;
  load(): Promise<void>;
  save(): Promise<void>;
  release(): Promise<void>;
}
