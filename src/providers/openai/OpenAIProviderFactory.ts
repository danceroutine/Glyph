import type { ChatProviderFactory } from '../../chat/ChatProviderFactory.ts';
import type { ConfigurationProvider } from '../../configuration/ConfigurationProvider.ts';
import { ProjectAccess } from '../../project/ProjectAccess.ts';
import type { ToolRuntime } from '../../tools/ToolRuntime.ts';
import { OpenAIProvider } from './OpenAIProvider.ts';

export class OpenAIProviderFactory implements ChatProviderFactory {
  constructor(
    private readonly projectRoot: string,
    private readonly configuration: ConfigurationProvider,
    private readonly tools?: ToolRuntime,
  ) {}

  create(model: string, token: () => Promise<string>): OpenAIProvider {
    return new OpenAIProvider(
      model,
      this.configuration.chat,
      token,
      undefined,
      this.tools ?? new ProjectAccess(this.projectRoot),
    );
  }
}
