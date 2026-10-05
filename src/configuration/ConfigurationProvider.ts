import type { OpenAIConfiguration } from '../providers/openai/OpenAIConfiguration.ts';
import type { ChatConfiguration } from './ChatConfiguration.ts';
import type { EditingConfiguration } from '../editing/EditingConfiguration.ts';

/** Host-facing configuration port. A VS Code adapter can read these values from WorkspaceConfiguration. */
export interface ConfigurationProvider {
  readonly stateDirectory: string;
  readonly configuredModel: string | undefined;
  readonly chat: ChatConfiguration;
  readonly editing: EditingConfiguration;
  readonly openAI: OpenAIConfiguration;
  readonly traceEnabled: boolean;
  readonly traceFile: string;
}
