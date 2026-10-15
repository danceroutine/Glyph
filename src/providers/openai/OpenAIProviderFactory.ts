import type OpenAI from 'openai';
import type { ChatProviderFactory } from '#src/chat/ChatProviderFactory.js';
import type { ChatProviderState } from '#src/chat/ChatProviderState.js';
import type { ConfigurationProvider } from '#src/configuration/ConfigurationProvider.js';
import { ProjectAccess } from '#src/project/ProjectAccess.js';
import { ProjectAgentInstructions } from '#src/project/prompts/ProjectAgentInstructions.js';
import type { ToolRuntime } from '#src/tools/ToolRuntime.js';
import { OpenAIProvider } from './OpenAIProvider.ts';

export class OpenAIProviderFactory implements ChatProviderFactory<() => Promise<string>> {
  constructor(
    private readonly projectRoot: string,
    private readonly configuration: ConfigurationProvider,
    private readonly tools?: ToolRuntime,
    private readonly client?: OpenAI,
  ) {}

  create(model: string, token: () => Promise<string>, state?: ChatProviderState): OpenAIProvider {
    return new OpenAIProvider(
      model,
      {
        ...this.configuration.chat,
        instructions: new ProjectAgentInstructions(this.configuration.chat.instructions).render(),
      },
      token,
      this.client,
      this.tools ?? new ProjectAccess(this.projectRoot),
      state,
    );
  }
}
