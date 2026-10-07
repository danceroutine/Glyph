import type { ChatProvider } from './ChatProvider.ts';
import type { ChatProviderState } from './ChatProviderState.ts';

/** Creates provider conversations without exposing provider construction to hosts. */
export interface ChatProviderFactory {
  create(model: string, token: () => Promise<string>, state?: ChatProviderState): ChatProvider;
}
