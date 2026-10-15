import type { OpenAISavedState } from './OpenAISavedState.ts';

/** Persists OpenAI account registrations and coordinates exclusive credential access. */
export interface OpenAIAccountStore {
  readonly state: OpenAISavedState;
  /** Shared stores outlive workspace sessions; refreshes follow this owner, not their first caller. */
  readonly lifetimeSignal?: AbortSignal;
  acquire(): Promise<void>;
  load(): Promise<void>;
  save(): Promise<void>;
  release(): Promise<void>;
}
