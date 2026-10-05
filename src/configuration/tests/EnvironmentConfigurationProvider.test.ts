import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors/ConfigurationError.ts';
import { EnvironmentConfigurationProvider } from '../EnvironmentConfigurationProvider.ts';

describe(EnvironmentConfigurationProvider, () => {
  it('maps environment values into host-facing configuration without reading API credentials', () => {
    const configuration = new EnvironmentConfigurationProvider({
      CHAT_MODEL: 'model-a', CHAT_TIMEOUT_MS: '90000', CHAT_TRACE: 'off',
      OPENAI_API_KEY: 'ignored', HARNESS_CHAT_CONFIG_DIR: '/tmp/harness-test',
    });

    expect(configuration.configuredModel).toBe('model-a');
    expect(configuration.chat.timeoutMs).toBe(90_000);
    expect(configuration.traceEnabled).toBe(false);
    expect(configuration.stateDirectory).toBe('/tmp/harness-test');
    expect(JSON.stringify(configuration)).not.toContain('ignored');
  });

  it('rejects an invalid chat timeout with a typed configuration error', () => {
    expect(() => new EnvironmentConfigurationProvider({ CHAT_TIMEOUT_MS: '-1' }))
      .toThrow(ConfigurationError);
  });
});
