import type { ChatProvider } from '#src/chat/ChatProvider.js';
import type { ChatProviderFactory } from '#src/chat/ChatProviderFactory.js';

export class FixtureChatProviderFactory implements ChatProviderFactory<() => Promise<string>> {
  constructor(private readonly provider: ChatProvider) {}
  create(): ChatProvider {
    return this.provider;
  }
}
