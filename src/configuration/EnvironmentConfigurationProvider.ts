import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from '../errors/ConfigurationError.ts';
import type { OpenAIConfiguration } from '../providers/openai/OpenAIConfiguration.ts';
import type { ChatConfiguration } from './ChatConfiguration.ts';
import type { ConfigurationProvider } from './ConfigurationProvider.ts';

const environmentConfigurationSchema = z.object({
  HARNESS_CHAT_CONFIG_DIR: z.string().trim().optional()
    .transform(value => value || join(homedir(), '.config', 'harness-chat-chatgpt')),
  CHAT_MODEL: z.string().trim().optional().transform(value => value || undefined),
  CHAT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  CHAT_INSTRUCTIONS: z.string().default('You are a helpful assistant. Be clear and concise.'),
  CHAT_TRACE: z.stringbool({
    truthy: ['1', 'true', 'on'],
    falsy: ['0', 'false', 'off'],
  }).default(true),
  CHAT_TRACE_FILE: z.string().trim().optional().transform(value => value || undefined),
}).transform(values => {
  const stateDirectory = values.HARNESS_CHAT_CONFIG_DIR;
  return {
    stateDirectory,
    configuredModel: values.CHAT_MODEL,
    chat: {
      instructions: values.CHAT_INSTRUCTIONS,
      timeoutMs: values.CHAT_TIMEOUT_MS,
    },
    openAI: {
      issuer: 'https://auth.openai.com',
      resource: 'https://api.openai.com/v1',
      scopes: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      planScope: 'chatgpt.tokens.use.direct',
      requestTimeoutMs: 30_000,
    },
    traceEnabled: values.CHAT_TRACE,
    traceFile: values.CHAT_TRACE_FILE
      ? resolve(values.CHAT_TRACE_FILE)
      : join(stateDirectory, 'harness-trace.log'),
  } satisfies ConfigurationProvider;
});

export class EnvironmentConfigurationProvider implements ConfigurationProvider {
  readonly stateDirectory: string;
  readonly configuredModel: string | undefined;
  readonly chat: ChatConfiguration;
  readonly openAI: OpenAIConfiguration;
  readonly traceEnabled: boolean;
  readonly traceFile: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const result = environmentConfigurationSchema.safeParse(env);
    if (!result.success) {
      throw new ConfigurationError(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
    }
    this.stateDirectory = result.data.stateDirectory;
    this.configuredModel = result.data.configuredModel;
    this.chat = result.data.chat;
    this.openAI = result.data.openAI;
    this.traceEnabled = result.data.traceEnabled;
    this.traceFile = result.data.traceFile;
  }
}
