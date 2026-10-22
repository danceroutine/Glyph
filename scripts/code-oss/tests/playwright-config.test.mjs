import { expect, it, onTestFinished, vi } from 'vitest';

it.each([
  ['true', 10, true],
  ['', 0, false],
])('uses bounded failure recovery in CI=%s', async (ci, maxFailures, forbidOnly) => {
  vi.stubEnv('CI', ci);
  vi.resetModules();
  vi.doMock('#code-oss/tests/electron/playwright.mjs', () => ({
    defineConfig: (/** @type {unknown} */ config) => config,
  }));
  onTestFinished(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('#code-oss/tests/electron/playwright.mjs');
  });

  const { default: config } = await import('#code-oss/tests/electron/playwright.config.mjs');

  expect(config.maxFailures).toBe(maxFailures);
  expect(config.forbidOnly).toBe(forbidOnly);
  expect(config.retries).toBe(1);
});
