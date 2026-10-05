import type { ChatProviderFactory } from '../../chat/ChatProviderFactory.ts';
import type { ConfigurationProvider } from '../../configuration/ConfigurationProvider.ts';
import { ProjectAccess } from '../../project/ProjectAccess.ts';
import { OpenAIProvider } from './OpenAIProvider.ts';

export class OpenAIProviderFactory implements ChatProviderFactory {
  constructor(
    private readonly projectRoot: string,
    private readonly configuration: ConfigurationProvider,
  ) {}

  create(model: string, token: () => Promise<string>): OpenAIProvider {
    return new OpenAIProvider(
      model,
      this.configuration.chat,
      token,
      undefined,
      new ProjectAccess(this.projectRoot),
    );
  }
}
