import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from './playwright.mjs';

export default defineConfig({
  testDir: '.',
  globalSetup: fileURLToPath(new URL('./backgroundApplication.mjs', import.meta.url)),
  testMatch: '**/*.test.mjs',
  outputDir: fileURLToPath(new URL('../../../.artifacts/code-oss-integration/results', import.meta.url)),
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  maxFailures: process.env.CI ? 10 : 0,
  workers: Number(process.env.GLYPH_ELECTRON_WORKERS ?? Math.max(1, Math.floor(availableParallelism() / 2))),
  retries: 1,
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: fileURLToPath(new URL('../../../.artifacts/code-oss-integration/report', import.meta.url)),
        open: 'never',
      },
    ],
    [
      'json',
      {
        outputFile: fileURLToPath(new URL('../../../.artifacts/code-oss-integration/results.json', import.meta.url)),
      },
    ],
  ],
});
