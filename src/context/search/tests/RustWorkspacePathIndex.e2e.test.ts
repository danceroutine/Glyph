import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectAccess } from '../../../project/ProjectAccess.ts';
import { FileSystemWorkspaceTextStore } from '../../../workspace/FileSystemWorkspaceTextStore.ts';
import { RustWorkspacePathIndex } from '../RustWorkspacePathIndex.ts';

describe(RustWorkspacePathIndex, () => {
  describe('workspace path queries', () => {
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
      let search = new RustWorkspacePathIndex({
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
