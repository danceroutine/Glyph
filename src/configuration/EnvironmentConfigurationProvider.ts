import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from '../errors/ConfigurationError.ts';
import type { OpenAIConfiguration } from '../providers/openai/OpenAIConfiguration.ts';
import type { ChatConfiguration } from './ChatConfiguration.ts';
import type { EditingConfiguration } from '../editing/configuration/EditingConfiguration.ts';
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
  EDIT_MAX_RAW_PROPOSAL_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  EDIT_MAX_CHANGED_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  EDIT_MAX_RESULTING_BYTES_PER_FILE: z.coerce.number().int().positive().default(1024 * 1024),
  EDIT_MAX_FILES: z.coerce.number().int().positive().default(64),
  EDIT_MAX_TOTAL_HUNKS: z.coerce.number().int().positive().default(256),
  EDIT_MAX_HUNKS_PER_FILE: z.coerce.number().int().positive().default(64),
  EDIT_DIFF_BUDGET_MS: z.coerce.number().int().positive().default(1_000),
  EDIT_MAX_ACTIVE_REVIEWS: z.coerce.number().int().min(1).max(1).default(1),
}).transform(values => {
  const stateDirectory = values.HARNESS_CHAT_CONFIG_DIR;
  return {
    stateDirectory,
    configuredModel: values.CHAT_MODEL,
    chat: {
      instructions: values.CHAT_INSTRUCTIONS,
      timeoutMs: values.CHAT_TIMEOUT_MS,
    },
    editing: {
      maxRawProposalBytes: values.EDIT_MAX_RAW_PROPOSAL_BYTES,
      maxChangedBytes: values.EDIT_MAX_CHANGED_BYTES,
      maxResultingBytesPerFile: values.EDIT_MAX_RESULTING_BYTES_PER_FILE,
      maxFiles: values.EDIT_MAX_FILES,
      maxTotalHunks: values.EDIT_MAX_TOTAL_HUNKS,
      maxHunksPerFile: values.EDIT_MAX_HUNKS_PER_FILE,
      diffBudgetMs: values.EDIT_DIFF_BUDGET_MS,
      maxActiveReviews: values.EDIT_MAX_ACTIVE_REVIEWS,
      newFileByteOrderMark: false,
      newFileLineEnding: '\n',
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
  readonly editing: EditingConfiguration;
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
    this.editing = result.data.editing;
    this.openAI = result.data.openAI;
    this.traceEnabled = result.data.traceEnabled;
    this.traceFile = result.data.traceFile;
  }
}
