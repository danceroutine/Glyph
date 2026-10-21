import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import type { Plugin } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const typescript = (path: string) => path.replace(/\.js$/, '.ts');

const codeOssAliases: Plugin = {
  name: 'glyph-code-oss-aliases',
  enforce: 'pre',
  resolveId(id, importer) {
    if (id === './ui/mountGlyphWorkbench.js' && importer?.includes('/code-oss/overlay/'))
      return resolve(root, 'code-oss/ui/mountGlyphWorkbench.tsx');
    if (id.startsWith('#glyph/protocol/')) return resolve(root, 'src/desktop/protocol', typescript(id.slice(16)));
    if (id.startsWith('#glyph/workbench/')) return resolve(root, 'src/desktop/workbench', typescript(id.slice(17)));
    if (id === '#vs/platform/glyph/reviewing/AgentReview.js') return resolve(root, 'src/reviewing/AgentReview.ts');
    if (id === '#vs/platform/glyph/chat/AgentMode.js') return resolve(root, 'src/chat/AgentMode.ts');
    if (id.startsWith('#vs/')) {
      const overlay = resolve(root, 'code-oss/overlay/src/vs', typescript(id.slice(4)));
      return existsSync(overlay) ? overlay : resolve(root, '.code-oss/src/src/vs', typescript(id.slice(4)));
    }
    return undefined;
  },
};

export default defineConfig({
  plugins: [codeOssAliases],
  test: {
    testTimeout: 30_000,
    exclude: [...configDefaults.exclude, '**/.code-oss/**', 'code-oss/tests/electron/**'],
    coverage: {
      provider: 'v8',
      autoAttachSubprocess: true,
      include: ['src/**/*.{ts,tsx}', 'code-oss/ui/**/*.{ts,tsx}', 'code-oss/overlay/**/*.ts', 'scripts/**/*.mjs'],
      exclude: [
        '**/test/**',
        '**/tests/**',
        '**/*.test.{ts,tsx,mjs}',
        '**/*.test-d.ts',
        '**/*.d.ts',
        '**/*.stories.tsx',
      ],
      reporter: ['json', 'json-summary', 'text-summary'],
      reportsDirectory: 'coverage/vitest',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
          exclude: [...configDefaults.exclude, '**/*.e2e.test.ts', 'scripts/code-oss/tests/**'],
          typecheck: {
            enabled: true,
            include: ['code-oss/ui/**/*.test-d.ts'],
            tsconfig: 'code-oss/ui/tsconfig.json',
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['src/**/*.e2e.test.ts'],
          pool: 'forks',
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'code-oss',
          include: ['scripts/code-oss/tests/**/*.test.mjs', 'code-oss/tests/overlay/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'code-oss/tests/overlay/**/*.browser.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'overlay',
          include: ['code-oss/tests/overlay/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          include: ['code-oss/ui/**/*.test.{ts,tsx}'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
