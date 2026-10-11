import type { OpenAIConfiguration } from '#src/providers/openai/OpenAIConfiguration.js';
import type { ChatConfiguration } from './ChatConfiguration.ts';
import type { EditingConfiguration } from '#src/editing/configuration/EditingConfiguration.js';
import type { ContextAttachmentConfiguration } from '#src/context/attachments/ContextAttachmentConfiguration.js';

/** Host-facing configuration port. A VS Code adapter can read these values from WorkspaceConfiguration. */
export interface ConfigurationProvider {
  readonly stateDirectory: string;
  readonly configuredModel: string | undefined;
  readonly chat: ChatConfiguration;
  readonly contextAttachments: ContextAttachmentConfiguration;
  readonly editing: EditingConfiguration;
  readonly openAI: OpenAIConfiguration;
  readonly traceEnabled: boolean;
  readonly traceFile: string;
}
