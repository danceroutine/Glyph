import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { buildGlyphDiagram } from '#scripts/code-oss/build-diagram.mjs';

describe(buildGlyphDiagram, () => {
  it('writes a self-contained frame whose policy admits only its own script', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'glyph-diagram-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));

    await buildGlyphDiagram(join(directory, 'nested', 'ui'));

    expect(await readdir(join(directory, 'nested', 'ui'))).toEqual(['glyph-diagram.html']);
    const html = await readFile(join(directory, 'nested', 'ui', 'glyph-diagram.html'), 'utf8');
    const [, hash = '', script = ''] =
      /script-src 'sha256-([^']+)'[\s\S]*<body><script>([\s\S]*)<\/script><\/body>$/u.exec(html) ?? [];
    expect(createHash('sha256').update(script).digest('base64')).toBe(hash);
    expect(script).not.toMatch(/<\/script/iu);
    expect(html).toBe(
      `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">\n<body><script>${script}</script></body>`,
    );
  });
});

describe('build-diagram', () => {
  it('builds into the artifacts directory when run directly', async () => {
    const filesystem = { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
    const originalArgv = process.argv;
    onTestFinished(() => {
      process.argv = originalArgv;
      vi.doUnmock('node:fs/promises');
    });
    process.argv = ['node', fileURLToPath(new URL('../build-diagram.mjs', import.meta.url))];
    vi.resetModules();
    vi.doMock('node:fs/promises', () => filesystem);

    await import('#scripts/code-oss/build-diagram.mjs');

    expect(filesystem.mkdir).toHaveBeenCalledWith('.artifacts/diagram', { recursive: true });
    expect(filesystem.writeFile).toHaveBeenCalledWith(
      join('.artifacts/diagram', 'glyph-diagram.html'),
      expect.stringContaining('<body><script>'),
    );
  });
});
