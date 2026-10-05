import type { ChatProvider } from '../../../chat/ChatProvider.ts';
import type { ChatProviderFactory } from '../../../chat/ChatProviderFactory.ts';

export class FixtureChatProviderFactory implements ChatProviderFactory {
  constructor(private readonly provider: ChatProvider) {}
  create(): ChatProvider { return this.provider; }
}
