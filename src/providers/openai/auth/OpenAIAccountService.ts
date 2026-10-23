import type { OpenAIAccountStore } from './OpenAIAccountStore.ts';

/**
 * Application-owned lifetime for the exclusive OpenAI credential store. A
 * desktop host initializes this once and lends no-op lifecycle views to each
 * workspace backend, preventing one workspace from releasing another's lock.
 */
export class OpenAIAccountService {
  private initialized = false;
  private readonly borrowed: OpenAIAccountStore;
  private lifetime = new AbortController();
  private readonly saves = new Set<Promise<void>>();

  constructor(private readonly store: OpenAIAccountStore) {
    const lifetimeSignal = (): AbortSignal => this.lifetime.signal;
    this.borrowed = {
      get state() {
        return store.state;
      },
      get lifetimeSignal() {
        return lifetimeSignal();
      },
      acquire: async () => {
        this.requireInitialized();
      },
      load: async () => {
        this.requireInitialized();
      },
      save: async () => {
        this.requireInitialized();
        const pending = store.save();
        this.saves.add(pending);
        try {
          await pending;
        } finally {
          this.saves.delete(pending);
        }
      },
      release: async () => {},
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.lifetime = new AbortController();
    await this.store.acquire();
    this.initialized = true;
    try {
      await this.store.load();
    } catch (error) {
      this.initialized = false;
      try {
        await this.store.release();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Account initialization failed and cleanup was incomplete.', {
          cause: cleanupError,
        });
      }
      throw error;
    }
  }

  borrowStore(): OpenAIAccountStore {
    this.requireInitialized();
    return this.borrowed;
  }

  async dispose(): Promise<void> {
    if (!this.initialized) return;
    // No late network completion may start a save after shutdown begins. Writes
    // already handed to the store still own its lock until they have settled.
    this.lifetime.abort(new Error('The shared account store has stopped.'));
    this.initialized = false;
    await Promise.allSettled(this.saves);
    await this.store.release();
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('The application account service is not initialized.');
  }
}
