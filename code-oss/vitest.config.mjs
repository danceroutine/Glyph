import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Build-contract tests require the pinned upstream tree, unlike Glyph's standalone unit suite. */
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: { include: ['scripts/code-oss/tests/**/*.test.mjs'] },
});
