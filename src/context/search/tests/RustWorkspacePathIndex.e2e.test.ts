import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectAccess } from '#src/project/ProjectAccess.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { MultiRootWorkspacePathIndex } from '#src/context/search/MultiRootWorkspacePathIndex.js';

describe(RustWorkspacePathIndex, () => {
  describe('workspace path queries', () => {
    it('returns escaped context within the multi-root response budget through the real Rust process', async () => {
      const root = await mkdtemp(join(tmpdir(), 'context-index-escaped-'));
      const native = new RustWorkspacePathIndex({
        root,
        binaryPath: resolve(
          'target',
          'release',
          process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
        ),
      });
      const index = new MultiRootWorkspacePathIndex('fixture', [{ name: 'app', index: native }]);
      try {
        const block = Array.from(
          { length: 41 },
          (_, line) => `${line === 20 ? 'needle' : ''}${'\\'.repeat(8186)}\n`,
        ).join('');
        await writeFile(join(root, 'escaped.txt'), block.repeat(2));
        const locations: number[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const result = await index.searchContents('needle', {
            patternKind: 'literal',
            outputMode: 'content',
            linesBefore: 20,
            linesAfter: 20,
            limit: 10,
            offset,
          });
          expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(512 * 1024);
          if (result.outputMode !== 'content') throw new Error('Expected content search matches.');
          expect(result.matches.length).toBeGreaterThan(0);
          for (const found of result.matches) {
            expect(found).toMatchObject({ path: 'app/escaped.txt', matchedText: 'needle', column: 1, endColumn: 7 });
            locations.push(found.line);
          }
          if (result.nextOffset !== null) expect(result.nextOffset).toBeGreaterThan(offset);
          offset = result.nextOffset;
        }
        expect(locations).toEqual([21, 62]);
      } finally {
        await index.dispose();
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);

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
      await writeFile(join(project, '.git-credentials'), 'https://user:never-index-this@example.test\n');
      await writeFile(join(project, '.glyph-state', 'accounts.json'), '{"refreshToken":"never-index-this"}\n');
      let search = new RustWorkspacePathIndex({
        binaryPath,
        root: project,
        cachePath: join(state, 'paths.bin'),
        excludedPaths: ['.glyph-state'],
        caseSensitive: false,
      });

      try {
        const cold = await search.initialize();
        expect(cold.fromCache).toBe(false);
        await expect(
          search.filterPaths(['SRC/APP.TSX', '.env', '.glyph-state/accounts.json', 'missing.ts']),
        ).resolves.toEqual(['src/App.tsx']);
        await expect(search.search('apptsx', { generation: 1, limit: 5 })).resolves.toMatchObject({
          matches: [expect.objectContaining({ path: 'src/App.tsx' })],
        });
        await expect(search.search('secret', { generation: 2, limit: 5 })).resolves.toMatchObject({ matches: [] });
        await expect(search.search('accounts', { generation: 3, limit: 5 })).resolves.toMatchObject({ matches: [] });
        await expect(search.glob('*.tsx', { targetDirectory: 'src', limit: 2_000 })).resolves.toEqual({
          files: ['src/App.tsx'],
          truncated: false,
        });
        await expect(search.glob('.env*', { limit: 2_000 })).resolves.toEqual({
          files: [],
          truncated: false,
        });
        await expect(
          search.searchContents('App', {
            patternKind: 'literal',
            path: 'src',
            fileGlob: '*.tsx',
            fileType: 'ts',
            outputMode: 'content',
            linesBefore: 0,
            linesAfter: 0,
            caseSensitive: true,
            multiline: false,
            limit: 20,
            offset: 0,
          }),
        ).resolves.toMatchObject({
          outputMode: 'content',
          matches: [expect.objectContaining({ path: 'src/App.tsx', line: 1, matchedText: 'App' })],
          truncated: false,
        });
        await expect(
          search.searchContents('never-index-this', {
            patternKind: 'literal',
            outputMode: 'files_with_matches',
            linesBefore: 0,
            linesAfter: 0,
            caseSensitive: true,
            multiline: false,
            limit: 20,
            offset: 0,
          }),
        ).resolves.toMatchObject({ files: [] });
        const access = new ProjectAccess(project, {}, new FileSystemWorkspaceTextStore(project), search);
        const toolResult = JSON.parse(
          await access.execute(
            'search_project_contents',
            JSON.stringify({
              pattern: 'App',
              pattern_kind: 'literal',
              path: 'src',
              file_glob: '*.tsx',
              file_type: 'ts',
              output_mode: 'files_with_matches',
              lines_before: 0,
              lines_after: 0,
              case_sensitive: true,
              multiline: false,
              limit: 20,
              offset: 0,
            }),
          ),
        ) as { files: string[] };
        expect(toolResult.files).toEqual(['src/App.tsx']);

        await writeFile(join(project, 'src', 'ApplicationState.ts'), 'export const state = {};\n');
        await search.refresh();
        await expect(search.search('appstate', { generation: 4, limit: 5 })).resolves.toMatchObject({
          matches: [expect.objectContaining({ path: 'src/ApplicationState.ts' })],
        });
        await expect(search.glob('*.ts', { targetDirectory: 'src', limit: 2_000 })).resolves.toEqual({
          files: ['src/ApplicationState.ts'],
          truncated: false,
        });
        await writeFile(join(project, 'src', 'ApplicationState.ts'), 'export const updatedState = {};\n');
        await expect(
          search.searchContents('updatedState', {
            patternKind: 'literal',
            path: 'src/ApplicationState.ts',
            outputMode: 'count',
            linesBefore: 0,
            linesAfter: 0,
            caseSensitive: true,
            multiline: false,
            limit: 20,
            offset: 0,
          }),
        ).resolves.toMatchObject({
          outputMode: 'count',
          counts: [{ path: 'src/ApplicationState.ts', count: 1 }],
        });
        await search.dispose();

        search = new RustWorkspacePathIndex({
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
