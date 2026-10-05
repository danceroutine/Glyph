import type { ChatProvider } from './ChatProvider.ts';

/** Creates provider conversations without exposing provider construction to hosts. */
export interface ChatProviderFactory {
  create(model: string, token: () => Promise<string>): ChatProvider;
}
