import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors/ConfigurationError.ts';
import { EnvironmentConfigurationProvider } from '../EnvironmentConfigurationProvider.ts';

describe(EnvironmentConfigurationProvider, () => {
  it('maps environment values into host-facing configuration without reading API credentials', () => {
    const configuration = new EnvironmentConfigurationProvider({
      CHAT_MODEL: 'model-a',
      CHAT_TIMEOUT_MS: '90000',
      CHAT_TRACE: 'off',
      CONTEXT_MAX_FILES: '12',
      CONTEXT_MAX_FILE_BYTES: '4096',
      CONTEXT_MAX_TOTAL_BYTES: '16384',
      OPENAI_API_KEY: 'ignored',
      HARNESS_CHAT_CONFIG_DIR: '/tmp/harness-test',
    });

    expect(configuration.configuredModel).toBe('model-a');
    expect(configuration.chat.timeoutMs).toBe(90_000);
    expect(configuration.traceEnabled).toBe(false);
    expect(configuration.stateDirectory).toBe('/tmp/harness-test');
    expect(configuration.contextAttachments).toEqual({
      maxFiles: 12,
      maxFileBytes: 4_096,
      maxTotalBytes: 16_384,
    });
    expect(configuration.editing).toEqual(
      expect.objectContaining({
        maxRawProposalBytes: 1024 * 1024,
        maxChangedBytes: 1024 * 1024,
        maxResultingBytesPerFile: 1024 * 1024,
        maxFiles: 64,
        maxTotalHunks: 256,
        maxHunksPerFile: 64,
        diffBudgetMs: 1_000,
        maxActiveReviews: 1,
        newFileByteOrderMark: false,
        newFileLineEnding: '\n',
      }),
    );
    expect(JSON.stringify(configuration)).not.toContain('ignored');
  });

  it('rejects an invalid chat timeout with a typed configuration error', () => {
    expect(() => new EnvironmentConfigurationProvider({ CHAT_TIMEOUT_MS: '-1' })).toThrow(ConfigurationError);
  });
});
