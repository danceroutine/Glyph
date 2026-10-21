import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

describe('glyphHostBootstrap', () => {
  it('requires the desktop host entry point', async () => {
    vi.resetModules();
    vi.stubEnv('GLYPH_DESKTOP_HOST_ENTRY', '');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    await expect(import('#vs/platform/glyph/node/glyphHostBootstrap.js')).rejects.toThrow(
      'GLYPH_DESKTOP_HOST_ENTRY is required.',
    );
  });

  it('loads the configured desktop host entry point', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-host-bootstrap-'));
    const entry = join(directory, 'utilityMain.mjs');
    await writeFile(entry, 'globalThis.__glyphHostBootstrapLoaded = true;\n');
    vi.resetModules();
    vi.stubEnv('GLYPH_DESKTOP_HOST_ENTRY', entry);
    onTestFinished(async () => {
      vi.unstubAllEnvs();
      delete (globalThis as { __glyphHostBootstrapLoaded?: boolean }).__glyphHostBootstrapLoaded;
      await rm(directory, { recursive: true, force: true });
    });

    await import('#vs/platform/glyph/node/glyphHostBootstrap.js');

    expect((globalThis as { __glyphHostBootstrapLoaded?: boolean }).__glyphHostBootstrapLoaded).toBe(true);
  });
});
