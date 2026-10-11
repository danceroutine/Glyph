import type { OpenAIAccountStore } from './OpenAIAccountStore.ts';

/**
 * Application-owned lifetime for the exclusive OpenAI credential store. A
 * desktop host initializes this once and lends no-op lifecycle views to each
 * workspace backend, preventing one workspace from releasing another's lock.
 */
export class OpenAIAccountService {
  private initialized = false;
  private readonly borrowed: OpenAIAccountStore;

  constructor(private readonly store: OpenAIAccountStore) {
    this.borrowed = {
      get state() {
        return store.state;
      },
      acquire: async () => this.requireInitialized(),
      load: async () => this.requireInitialized(),
      save: () => {
        this.requireInitialized();
        return store.save();
      },
      release: async () => {},
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.acquire();
    this.initialized = true;
    try {
      await this.store.load();
    } catch (error) {
      this.initialized = false;
      try {
        await this.store.release();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Account initialization failed and cleanup was incomplete.');
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
    this.initialized = false;
    await this.store.release();
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('The application account service is not initialized.');
  }
}
