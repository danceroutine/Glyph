import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RustWorkspaceFileSearch } from '../RustWorkspaceFileSearch.ts';

describe(RustWorkspaceFileSearch, () => {
  describe(RustWorkspaceFileSearch.prototype.search, () => {
    it('searches and refreshes a cached workspace through the real Rust process', async () => {
      const project = await mkdtemp(join(tmpdir(), 'context-index-project-'));
      const state = await mkdtemp(join(tmpdir(), 'context-index-state-'));
      const binaryPath = resolve(
        'target',
        'release',
        process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
      );
      await mkdir(join(project, 'src'), { recursive: true });
      await mkdir(join(project, '.glyph-state'), { recursive: true });
      await writeFile(join(project, 'src', 'App.tsx'), 'export function App() {}\n');
      await writeFile(join(project, '.env'), 'SECRET=never-index-this\n');
      await writeFile(join(project, '.glyph-state', 'accounts.json'), '{"refreshToken":"never-index-this"}\n');
      let search = new RustWorkspaceFileSearch({
        binaryPath,
        root: project,
        cachePath: join(state, 'paths.bin'),
        excludedPaths: ['.glyph-state'],
      });

      try {
        const cold = await search.initialize();
        expect(cold.fromCache).toBe(false);
        await expect(search.search('apptsx', { generation: 1, limit: 5 })).resolves.toMatchObject({
          matches: [expect.objectContaining({ path: 'src/App.tsx' })],
        });
        await expect(search.search('secret', { generation: 2, limit: 5 })).resolves.toMatchObject({ matches: [] });
        await expect(search.search('accounts', { generation: 3, limit: 5 })).resolves.toMatchObject({ matches: [] });

        await writeFile(join(project, 'src', 'ApplicationState.ts'), 'export const state = {};\n');
        await search.refresh();
        await expect(search.search('appstate', { generation: 4, limit: 5 })).resolves.toMatchObject({
          matches: [expect.objectContaining({ path: 'src/ApplicationState.ts' })],
        });
        await search.dispose();

        search = new RustWorkspaceFileSearch({
          binaryPath,
          root: project,
          cachePath: join(state, 'paths.bin'),
          excludedPaths: ['.glyph-state'],
        });
        await expect(search.initialize()).resolves.toMatchObject({ fromCache: true, fileCount: 2 });
      } finally {
        await search.dispose().catch(() => {});
        await rm(project, { recursive: true, force: true });
        await rm(state, { recursive: true, force: true });
      }
    }, 30_000);
  });
});
