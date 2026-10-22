import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import type { StorybookConfig } from '@storybook/preact-vite';

const config: StorybookConfig = {
  framework: '@storybook/preact-vite',
  staticDirs: ['../../.artifacts/diagram'],
  stories: ['../ui/**/*.stories.tsx'],
  core: { disableTelemetry: true },
  async viteFinal(viteConfig) {
    const { mergeConfig } = await import('vite');
    return mergeConfig(viteConfig, {
      plugins: [preact()],
      optimizeDeps: { include: ['preact', 'preact/hooks', 'preact/jsx-runtime'] },
      // The root package's Node imports target emitted .js files. Preview the
      // editable TypeScript sources without building Glyph or Code OSS first.
      resolve: {
        dedupe: ['preact'],
        alias: {
          '#src': fileURLToPath(new URL('../../src', import.meta.url)),
          '#code-oss': fileURLToPath(new URL('..', import.meta.url)),
        },
      },
    });
  },
};

export default config;
