import type { ChatProvider } from './ChatProvider.ts';
import type { ChatProviderState } from './ChatProviderState.ts';

/** Provider-internal factory parameterized by that provider's credential representation. */
export interface ChatProviderFactory<TCredential> {
  create(model: string, credential: TCredential, state?: ChatProviderState): ChatProvider;
}
