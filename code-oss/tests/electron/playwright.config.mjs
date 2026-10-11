import { fileURLToPath } from 'node:url';
import { defineConfig } from './playwright.mjs';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.test.mjs',
  outputDir: fileURLToPath(new URL('../../../.artifacts/code-oss-integration/results', import.meta.url)),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
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
