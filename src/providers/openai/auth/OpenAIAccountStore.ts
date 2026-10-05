import type { OpenAISavedState } from './OpenAISavedState.ts';

export interface OpenAIAccountStore {
  readonly state: OpenAISavedState;
  acquire(): Promise<void>;
  load(): Promise<void>;
  save(): Promise<void>;
  release(): Promise<void>;
}
