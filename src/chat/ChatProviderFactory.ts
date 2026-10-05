import type { ChatProvider } from './ChatProvider.ts';

export interface ChatProviderFactory {
  create(model: string, token: () => Promise<string>): ChatProvider;
}
