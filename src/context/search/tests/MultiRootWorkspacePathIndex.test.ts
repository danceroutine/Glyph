import { describe, expect, it, vi } from 'vitest';
import type { FileSearchResult } from '#src/context/search/FileSearchResult.js';
import { MultiRootWorkspacePathIndex } from '#src/context/search/MultiRootWorkspacePathIndex.js';
import type { WorkspaceContentSearchOptions } from '#src/context/search/WorkspaceContentSearchOptions.js';
import { workspaceContentSearchOptionsSchema } from '#src/context/search/WorkspaceContentSearchOptions.js';
import type { WorkspaceContentSearchResult } from '#src/context/search/WorkspaceContentSearchResult.js';
import type { WorkspacePathGlobResult } from '#src/context/search/WorkspacePathGlobResult.js';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import type { WorkspacePathIndexState } from '#src/context/search/WorkspacePathIndexState.js';

describe(MultiRootWorkspacePathIndex, () => {
  it.each(['app', '🧪/app'])(
    '[round11-03] offsets native code-point highlights through an emoji root for %s',
    async query => {
      const native = new FixtureIndex('root', 'app.ts', 10);
      vi.spyOn(native, 'search').mockResolvedValue({
        generation: 1,
        query: 'app',
        fileCount: 1,
        matches: [{ path: 'app.ts', score: 10, indices: [0, 1, 2] }],
      });
      const index = new MultiRootWorkspacePathIndex('workspace', [{ name: '🧪', index: native }]);
      const result = await index.search(query, { generation: 1 });
      expect(result.matches[0]).toEqual({ path: '🧪/app.ts', score: 10, indices: [2, 3, 4] });
      const match = result.matches[0]!;
      expect(match.indices.map(position => Array.from(match.path)[position]).join('')).toBe('app');
    },
  );

  it('[round3-04] returns the requested match at the maximum offset without fetching an invalid extra page', async () => {
    const api = new FixtureIndex('api', 'file.ts', 1);
    const search = vi.spyOn(api, 'searchContents').mockImplementation(async (_pattern, options) => {
      const { offset, limit } = workspaceContentSearchOptionsSchema.parse(options);
      return {
        outputMode: 'files_with_matches',
        files: Array.from({ length: limit }, (_, i) => `file-${offset + i}.ts`),
        searchedFiles: 200000,
        skippedFiles: 0,
        indexTruncated: false,
        truncated: true,
        nextOffset: offset + limit,
      };
    });
    const index = new MultiRootWorkspacePathIndex('workspace', [{ name: 'api', index: api }]);
    await expect(
      index.searchContents('x', { outputMode: 'files_with_matches', offset: 100000, limit: 1 }),
    ).resolves.toMatchObject({ files: ['api/file-100000.ts'], truncated: true, nextOffset: null });
    expect(search.mock.calls.every(([, options]) => (options.offset ?? 0) <= 100000)).toBe(true);
  });
  it('[round2-09] bounds combined content and continues from the first unreturned match across native pages', async () => {
    const api = new FixtureIndex('api', 'file.ts', 1);
    const search = vi.spyOn(api, 'searchContents').mockImplementation(async (_pattern, options) => {
      const offset = options.offset ?? 0;
      return {
        outputMode: 'content',
        matches: [
          {
            path: `file-${offset}.ts`,
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 2,
            lineText: 'x'.repeat(8192),
            matchedText: 'x',
            linesBefore: Array.from({ length: 20 }, (_, number) => ({ number: number + 1, content: 'x'.repeat(8192) })),
            linesAfter: Array.from({ length: 20 }, (_, number) => ({ number: number + 22, content: 'x'.repeat(8192) })),
          },
        ],
        searchedFiles: 3,
        skippedFiles: 0,
        indexTruncated: false,
        truncated: offset < 2,
        nextOffset: offset < 2 ? offset + 1 : null,
      };
    });
    const index = new MultiRootWorkspacePathIndex('workspace', [{ name: 'api', index: api }]);
    const first = await index.searchContents('x', { outputMode: 'content', limit: 3 });
    if (first.outputMode !== 'content') throw new Error('Expected content matches');
    expect.soft(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(512 * 1024);
    expect.soft(first.truncated).toBe(true);
    expect.soft(first.nextOffset).toBe(first.matches.length);
    expect.soft(search.mock.calls.length).toBeLessThanOrEqual(3);
    const next = await index.searchContents('x', { outputMode: 'content', limit: 3, offset: first.matches.length });
    if (next.outputMode !== 'content') throw new Error('Expected content matches');
    expect(next.matches[0]?.path).toBe(`api/file-${first.matches.length}.ts`);
  });

  it('merges native index state, fuzzy matches, and glob results into named paths', async () => {
    const api = new FixtureIndex('api', 'src/server.ts', 10);
    const web = new FixtureIndex('web', 'src/App.tsx', 20);
    const index = new MultiRootWorkspacePathIndex('workspace', [
      { name: 'api', index: api },
      { name: 'web', index: web },
    ]);

    await expect(index.initialize()).resolves.toMatchObject({ root: 'workspace', fileCount: 2 });
    await expect(index.search('app', { generation: 4, limit: 1 })).resolves.toEqual({
      generation: 4,
      query: 'app',
      fileCount: 2,
      matches: [{ path: 'web/src/App.tsx', score: 20, indices: [4] }],
    });
    await expect(index.glob('web/*.tsx', { limit: 10 })).resolves.toEqual({
      files: ['web/src/App.tsx'],
      truncated: false,
    });
    expect(web.lastGlob).toEqual({ pattern: '*.tsx', targetDirectory: undefined });
    await expect(index.glob('*.ts', { targetDirectory: 'api/src', limit: 10 })).resolves.toEqual({
      files: ['api/src/server.ts'],
      truncated: false,
    });
    expect(api.lastGlob).toEqual({ pattern: '*.ts', targetDirectory: 'src' });
  });

  it('merges and paginates content results without losing their workspace folder', async () => {
    const api = new FixtureIndex('api', 'src/server.ts', 10);
    const web = new FixtureIndex('web', 'src/App.tsx', 20);
    const index = new MultiRootWorkspacePathIndex('workspace', [
      { name: 'api', index: api },
      { name: 'web', index: web },
    ]);

    await expect(
      index.searchContents('value', {
        patternKind: 'literal',
        outputMode: 'content',
        linesBefore: 0,
        linesAfter: 0,
        caseSensitive: true,
        multiline: false,
        limit: 1,
        offset: 1,
      }),
    ).resolves.toMatchObject({
      outputMode: 'content',
      matches: [{ path: 'web/src/App.tsx' }],
      searchedFiles: 2,
      truncated: false,
      nextOffset: null,
    });
    await expect(
      index.searchContents('value', {
        path: 'api/src',
        outputMode: 'files_with_matches',
        limit: 10,
        offset: 0,
      }),
    ).resolves.toMatchObject({ outputMode: 'files_with_matches', files: ['api/src/server.ts'] });
    expect(api.lastContentPath).toBe('src');
  });
});

class FixtureIndex implements WorkspacePathIndex {
  lastGlob: { pattern: string; targetDirectory: string | undefined } | undefined;
  lastContentPath: string | null | undefined;

  constructor(
    private readonly name: string,
    private readonly path: string,
    private readonly score: number,
  ) {}

  async initialize(): Promise<WorkspacePathIndexState> {
    return {
      root: this.name,
      fileCount: 1,
      fromCache: true,
      truncated: false,
      durationMilliseconds: 1,
    };
  }

  async search(query: string, options: { generation: number }): Promise<FileSearchResult> {
    return {
      generation: options.generation,
      query,
      fileCount: 1,
      matches: [{ path: this.path, score: this.score, indices: [0] }],
    };
  }

  async glob(pattern: string, options: { targetDirectory?: string; limit: number }): Promise<WorkspacePathGlobResult> {
    this.lastGlob = { pattern, targetDirectory: options.targetDirectory };
    return { files: [this.path], truncated: false };
  }

  async searchContents(
    _pattern: string,
    options: WorkspaceContentSearchOptions,
  ): Promise<WorkspaceContentSearchResult> {
    this.lastContentPath = options.path;
    const metadata = {
      searchedFiles: 1,
      skippedFiles: 0,
      indexTruncated: false,
      truncated: false,
      nextOffset: null,
    };
    switch (options.outputMode) {
      case 'files_with_matches':
        return { outputMode: 'files_with_matches', files: [this.path], ...metadata };
      case 'count':
        return { outputMode: 'count', counts: [{ path: this.path, count: 1 }], ...metadata };
      default:
        return {
          outputMode: 'content',
          matches: [
            {
              path: this.path,
              line: 1,
              column: 1,
              endLine: 1,
              endColumn: 6,
              lineText: 'value',
              matchedText: 'value',
              linesBefore: [],
              linesAfter: [],
            },
          ],
          ...metadata,
        };
    }
  }

  async refresh(): Promise<WorkspacePathIndexState> {
    return this.initialize();
  }

  async dispose(): Promise<void> {}
}
