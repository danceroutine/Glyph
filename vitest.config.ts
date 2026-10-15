import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.code-oss/**', 'code-oss/tests/electron/**', 'scripts/code-oss/tests/**'],
    typecheck: {
      enabled: true,
      include: ['code-oss/ui/**/*.test-d.ts'],
      tsconfig: 'code-oss/ui/tsconfig.json',
    },
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
