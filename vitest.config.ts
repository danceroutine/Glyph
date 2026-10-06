import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/terminal/ui/**/*.{ts,tsx}'],
      exclude: ['src/terminal/ui/**/test/**'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        100: true,
        perFile: true,
      },
    },
  },
});
