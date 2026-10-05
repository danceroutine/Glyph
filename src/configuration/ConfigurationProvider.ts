import type { OpenAIConfiguration } from '../providers/openai/OpenAIConfiguration.ts';
import type { ChatConfiguration } from './ChatConfiguration.ts';

/** Host-facing configuration port. A VS Code adapter can read these values from WorkspaceConfiguration. */
export interface ConfigurationProvider {
  readonly stateDirectory: string;
  readonly configuredModel: string | undefined;
  readonly chat: ChatConfiguration;
  readonly openAI: OpenAIConfiguration;
  readonly traceEnabled: boolean;
  readonly traceFile: string;
}
