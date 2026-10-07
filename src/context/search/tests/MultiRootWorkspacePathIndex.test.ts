import { describe, expect, it } from 'vitest';
import type { FileSearchResult } from '../FileSearchResult.ts';
import { MultiRootWorkspacePathIndex } from '../MultiRootWorkspacePathIndex.ts';
import type { WorkspaceContentSearchOptions } from '../WorkspaceContentSearchOptions.ts';
import type { WorkspaceContentSearchResult } from '../WorkspaceContentSearchResult.ts';
import type { WorkspacePathGlobResult } from '../WorkspacePathGlobResult.ts';
import type { WorkspacePathIndex } from '../WorkspacePathIndex.ts';
import type { WorkspacePathIndexState } from '../WorkspacePathIndexState.ts';

describe(MultiRootWorkspacePathIndex, () => {
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
