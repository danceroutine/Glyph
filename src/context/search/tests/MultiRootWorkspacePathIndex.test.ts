import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { FileSearchResult } from '#src/context/search/FileSearchResult.js';
import { MultiRootWorkspacePathIndex } from '#src/context/search/MultiRootWorkspacePathIndex.js';
import type { WorkspaceContentSearchOptions } from '#src/context/search/WorkspaceContentSearchOptions.js';
import { workspaceContentSearchOptionsSchema } from '#src/context/search/WorkspaceContentSearchOptions.js';
import type { WorkspaceContentSearchResult } from '#src/context/search/WorkspaceContentSearchResult.js';
import type { WorkspacePathGlobResult } from '#src/context/search/WorkspacePathGlobResult.js';
import type { WorkspacePathIndex } from '#src/context/search/WorkspacePathIndex.js';
import type { WorkspacePathIndexState } from '#src/context/search/WorkspacePathIndexState.js';

describe(MultiRootWorkspacePathIndex, () => {
  it.each([-1, 0, 100001])('keeps a full result without offering its unusable native cursor %s', async nextOffset => {
    const api = new FixtureIndex('api', 'found.ts', 1);
    vi.spyOn(api, 'searchContents').mockResolvedValue({
      outputMode: 'files_with_matches',
      files: ['found.ts'],
      searchedFiles: 1,
      skippedFiles: 0,
      indexTruncated: false,
      truncated: true,
      nextOffset,
    });
    const index = new MultiRootWorkspacePathIndex('workspace', [{ name: 'api', index: api }]);
    await expect(index.searchContents('x', { outputMode: 'files_with_matches', limit: 1 })).resolves.toMatchObject({
      files: ['api/found.ts'],
      truncated: true,
      nextOffset: null,
    });
  });

  it.each(['content', 'files_with_matches', 'count'] as const)(
    'continues %s search after an incomplete empty root without losing its warning',
    async outputMode => {
      const incomplete = new FixtureIndex('incomplete', 'omitted.ts', 1);
      const later = new FixtureIndex('later', 'found.ts', 1);
      const metadata = {
        searchedFiles: 0,
        skippedFiles: 0,
        indexTruncated: true,
        truncated: true,
        nextOffset: null,
      };
      vi.spyOn(incomplete, 'searchContents').mockImplementation(async () => {
        switch (outputMode) {
          case 'content':
            return { outputMode, matches: [], ...metadata };
          case 'files_with_matches':
            return { outputMode, files: [], ...metadata };
          case 'count':
            return { outputMode, counts: [], ...metadata };
        }
      });
      const laterSearch = vi.spyOn(later, 'searchContents');
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'incomplete', index: incomplete },
        { name: 'later', index: later },
      ]);
      const result = await index.searchContents('value', { outputMode, limit: 1 });
      expect(laterSearch).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ indexTruncated: true, truncated: true, nextOffset: null });
      switch (result.outputMode) {
        case 'content':
          expect(result.matches.map(match => match.path)).toEqual(['later/found.ts']);
          break;
        case 'files_with_matches':
          expect(result.files).toEqual(['later/found.ts']);
          break;
        case 'count':
          expect(result.counts.map(count => count.path)).toEqual(['later/found.ts']);
          break;
      }
    },
  );

  it('retains incomplete-index warnings while paging through available matches in later roots', async () => {
    const incomplete = new FixtureIndex('incomplete', 'omitted.ts', 1);
    vi.spyOn(incomplete, 'searchContents').mockResolvedValue({
      outputMode: 'files_with_matches',
      files: [],
      searchedFiles: 0,
      skippedFiles: 0,
      indexTruncated: true,
      truncated: true,
      nextOffset: null,
    });
    const later = new FixtureIndex('later', 'found.ts', 1);
    vi.spyOn(later, 'searchContents').mockImplementation(async (_pattern, options) => {
      const offset = options.offset ?? 0;
      const files = ['first.ts', 'second.ts'].slice(offset, offset + (options.limit ?? 100));
      const nextOffset = offset + files.length < 2 ? offset + files.length : null;
      return {
        outputMode: 'files_with_matches',
        files,
        searchedFiles: 2,
        skippedFiles: 0,
        indexTruncated: false,
        truncated: nextOffset !== null,
        nextOffset,
      };
    });
    const index = new MultiRootWorkspacePathIndex('workspace', [
      { name: 'incomplete', index: incomplete },
      { name: 'later', index: later },
    ]);
    await expect(index.searchContents('x', { outputMode: 'files_with_matches', limit: 1 })).resolves.toMatchObject({
      files: ['later/first.ts'],
      indexTruncated: true,
      truncated: true,
      nextOffset: 1,
    });
    await expect(
      index.searchContents('x', { outputMode: 'files_with_matches', limit: 1, offset: 1 }),
    ).resolves.toMatchObject({
      files: ['later/second.ts'],
      indexTruncated: true,
      truncated: true,
      nextOffset: null,
    });
  });

  it.each(['beyond ceiling', 'unavailable'] as const)(
    'keeps a partial page when its native continuation is %s',
    async cursor => {
      const api = new FixtureIndex('api', 'file.ts', 1);
      const search = vi.spyOn(api, 'searchContents').mockImplementation(async (_pattern, options) => {
        const { offset, limit } = workspaceContentSearchOptionsSchema.parse(options);
        const count = offset < 100000 ? limit : 1;
        const nextOffset = offset >= 100000 && cursor === 'unavailable' ? null : offset + count;
        return {
          outputMode: 'files_with_matches',
          files: Array.from({ length: count }, (_, n) => `file-${offset + n}.ts`),
          searchedFiles: 1,
          skippedFiles: 0,
          indexTruncated: false,
          truncated: true,
          nextOffset,
        };
      });
      const index = new MultiRootWorkspacePathIndex('workspace', [{ name: 'api', index: api }]);
      await expect(
        index.searchContents('x', { outputMode: 'files_with_matches', offset: 100000, limit: 2 }),
      ).resolves.toMatchObject({ files: ['api/file-100000.ts'], truncated: true, nextOffset: null });
      expect(search.mock.calls.every(([, options]) => (options.offset ?? 0) <= 100000)).toBe(true);
    },
  );

  it.each(['app', '🧪/app'])('offsets native code-point highlights through an emoji root for %s', async query => {
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
  });

  it('returns the requested match at the maximum offset without fetching an invalid extra page', async () => {
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
  it('bounds combined content and continues from the first unreturned match across native pages', async () => {
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

  it('requires at least one workspace folder', () => {
    expect(() => new MultiRootWorkspacePathIndex('workspace', [])).toThrow(
      'A multi-root workspace requires at least one path index.',
    );
  });

  it('requires unique workspace folder names', () => {
    expect(
      () =>
        new MultiRootWorkspacePathIndex('workspace', [
          { name: 'api', index: new FixtureIndex('api', 'one.ts', 1) },
          { name: 'api', index: new FixtureIndex('api', 'two.ts', 1) },
        ]),
    ).toThrow('Workspace folder names must be unique.');
  });

  describe(MultiRootWorkspacePathIndex.prototype.search, () => {
    it('orders equally scored matches by their qualified path', async () => {
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'web', index: new FixtureIndex('web', 'app.ts', 5) },
        { name: 'api', index: new FixtureIndex('api', 'app.ts', 5) },
      ]);

      const result = await index.search('app', { generation: 1 });

      expect(result.matches.map(match => match.path)).toEqual(['api/app.ts', 'web/app.ts']);
    });

    it('searches every folder when a query prefix does not name a workspace folder', async () => {
      const api = new FixtureIndex('api', 'src/a.ts', 1);
      const web = new FixtureIndex('web', 'src/b.ts', 2);
      const apiSearch = vi.spyOn(api, 'search');
      const webSearch = vi.spyOn(web, 'search');
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'api', index: api },
        { name: 'web', index: web },
      ]);

      const result = await index.search('src/a', { generation: 2 });

      expect(apiSearch).toHaveBeenCalledWith('src/a', { generation: 2 });
      expect(webSearch).toHaveBeenCalledWith('src/a', { generation: 2 });
      expect(result.matches.map(match => match.path)).toEqual(['web/src/b.ts', 'api/src/a.ts']);
    });
  });

  describe(MultiRootWorkspacePathIndex.prototype.glob, () => {
    it('stops at the limit and reports truncation before visiting later folders', async () => {
      const api = new FixtureIndex('api', 'one.ts', 1);
      const web = new FixtureIndex('web', 'two.ts', 1);
      const webGlob = vi.spyOn(web, 'glob');
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'api', index: api },
        { name: 'web', index: web },
      ]);

      await expect(index.glob('*.ts', { limit: 1 })).resolves.toEqual({ files: ['api/one.ts'], truncated: true });
      expect(webGlob).not.toHaveBeenCalled();
    });

    it('treats a bare folder prefix as every file in that folder and forwards cancellation', async () => {
      const api = new FixtureIndex('api', 'one.ts', 1);
      const web = new FixtureIndex('web', 'two.ts', 1);
      const apiGlob = vi.spyOn(api, 'glob');
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'api', index: api },
        { name: 'web', index: web },
      ]);
      const signal = new AbortController().signal;

      await expect(index.glob('web/', { limit: 5, signal })).resolves.toEqual({
        files: ['web/two.ts'],
        truncated: false,
      });
      expect(web.lastGlob).toEqual({ pattern: '**/*', targetDirectory: undefined });
      expect(apiGlob).not.toHaveBeenCalled();
    });

    it('forwards cancellation to each folder index', async () => {
      const api = new FixtureIndex('api', 'one.ts', 1);
      const apiGlob = vi.spyOn(api, 'glob');
      const index = new MultiRootWorkspacePathIndex('workspace', [{ name: 'api', index: api }]);
      const signal = new AbortController().signal;

      await index.glob('*.ts', { limit: 5, signal });

      expect(apiGlob).toHaveBeenCalledWith('*.ts', { limit: 5, signal });
    });

    it('targets a whole folder when the target directory names only the folder', async () => {
      const api = new FixtureIndex('api', 'one.ts', 1);
      const web = new FixtureIndex('web', 'two.ts', 1);
      const apiGlob = vi.spyOn(api, 'glob');
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'api', index: api },
        { name: 'web', index: web },
      ]);

      await expect(index.glob('*.ts', { targetDirectory: 'web', limit: 5 })).resolves.toEqual({
        files: ['web/two.ts'],
        truncated: false,
      });
      expect(web.lastGlob).toEqual({ pattern: '*.ts', targetDirectory: undefined });
      expect(apiGlob).not.toHaveBeenCalled();
    });

    it('rejects a target directory outside every workspace folder', async () => {
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'api', index: new FixtureIndex('api', 'one.ts', 1) },
      ]);

      await expect(index.glob('*.ts', { targetDirectory: 'docs/guides', limit: 5 })).rejects.toThrow(
        'Unknown workspace folder: docs',
      );
    });
  });

  describe(MultiRootWorkspacePathIndex.prototype.searchContents, () => {
    it('routes a folder-qualified file glob to that folder and forwards cancellation', async () => {
      const api = new FixtureIndex('api', 'src/server.ts', 1);
      const web = new FixtureIndex('web', 'src/App.tsx', 1);
      const apiSearch = vi.spyOn(api, 'searchContents');
      const webSearch = vi.spyOn(web, 'searchContents');
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'api', index: api },
        { name: 'web', index: web },
      ]);
      const signal = new AbortController().signal;

      const result = await index.searchContents('value', {
        fileGlob: 'web/**/*.tsx',
        outputMode: 'files_with_matches',
        signal,
      });

      expect(result).toMatchObject({ files: ['web/src/App.tsx'] });
      expect(apiSearch).not.toHaveBeenCalled();
      expect(webSearch).toHaveBeenCalledWith('value', expect.objectContaining({ fileGlob: '**/*.tsx', signal }));
    });

    it('keeps an unqualified file glob for every folder', async () => {
      const api = new FixtureIndex('api', 'src/server.ts', 1);
      const apiSearch = vi.spyOn(api, 'searchContents');
      const index = new MultiRootWorkspacePathIndex('workspace', [{ name: 'api', index: api }]);

      await index.searchContents('value', { fileGlob: '**/*.ts', outputMode: 'count' });

      expect(apiSearch).toHaveBeenCalledWith('value', expect.objectContaining({ fileGlob: '**/*.ts' }));
    });

    it('rejects a single entry that cannot fit in the response', async () => {
      const api = new FixtureIndex('api', 'big.ts', 1);
      vi.spyOn(api, 'searchContents').mockResolvedValue({
        outputMode: 'content',
        matches: [
          {
            path: 'big.ts',
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 2,
            lineText: 'x'.repeat(600 * 1024),
            matchedText: 'x',
            linesBefore: [],
            linesAfter: [],
          },
        ],
        searchedFiles: 1,
        skippedFiles: 0,
        indexTruncated: false,
        truncated: false,
        nextOffset: null,
      });
      const index = new MultiRootWorkspacePathIndex('workspace', [{ name: 'api', index: api }]);

      await expect(index.searchContents('x', { outputMode: 'content' })).rejects.toThrow(
        'A content-search entry exceeds the response byte limit.',
      );
    });

    it('rejects an output mode it does not know how to combine', async () => {
      const api = new FixtureIndex('api', 'file.ts', 1);
      vi.spyOn(api, 'searchContents').mockResolvedValue({
        outputMode: 'files_with_matches',
        files: [],
        searchedFiles: 0,
        skippedFiles: 0,
        indexTruncated: false,
        truncated: false,
        nextOffset: null,
      });
      const resolved = workspaceContentSearchOptionsSchema.parse({});
      const parse = vi
        .spyOn(workspaceContentSearchOptionsSchema, 'parse')
        .mockReturnValueOnce({ ...resolved, outputMode: 'unknown' as 'content' });
      onTestFinished(() => {
        parse.mockRestore();
      });
      const index = new MultiRootWorkspacePathIndex('workspace', [{ name: 'api', index: api }]);

      await expect(index.searchContents('x', {})).rejects.toThrow('Unsupported content-search output mode.');
    });

    it('rejects a native page whose continuation does not advance', async () => {
      const api = new FixtureIndex('api', 'file.ts', 1);
      vi.spyOn(api, 'searchContents').mockResolvedValue({
        outputMode: 'files_with_matches',
        files: [],
        searchedFiles: 1,
        skippedFiles: 0,
        indexTruncated: false,
        truncated: true,
        nextOffset: 0,
      });
      const index = new MultiRootWorkspacePathIndex('workspace', [{ name: 'api', index: api }]);

      await expect(index.searchContents('x', { outputMode: 'files_with_matches' })).rejects.toThrow(
        'Content search returned a non-advancing page offset.',
      );
    });

    it.each([
      { truncated: false, indexTruncated: false, nextOffset: 1 },
      { truncated: true, indexTruncated: true, nextOffset: 1 },
      { truncated: true, indexTruncated: false, nextOffset: null },
    ])(
      'continues into later folders after a full first folder page truncated $truncated with index truncated $indexTruncated',
      async ({ truncated, indexTruncated, nextOffset }) => {
        const api = new FixtureIndex('api', 'one.ts', 1);
        vi.spyOn(api, 'searchContents').mockResolvedValue({
          outputMode: 'files_with_matches',
          files: ['one.ts'],
          searchedFiles: 1,
          skippedFiles: 0,
          indexTruncated,
          truncated,
          nextOffset: null,
        });
        const index = new MultiRootWorkspacePathIndex('workspace', [
          { name: 'api', index: api },
          { name: 'web', index: new FixtureIndex('web', 'two.ts', 1) },
        ]);

        const result = await index.searchContents('x', { outputMode: 'files_with_matches', limit: 1 });

        expect(result).toMatchObject({ files: ['api/one.ts'], truncated: true, nextOffset });
      },
    );
  });

  describe(MultiRootWorkspacePathIndex.prototype.refresh, () => {
    it('combines refreshed state from every folder and forwards cancellation', async () => {
      const api = new FixtureIndex('api', 'one.ts', 1);
      const web = new FixtureIndex('web', 'two.ts', 1);
      vi.spyOn(web, 'refresh').mockResolvedValue({
        root: 'web',
        fileCount: 4,
        fromCache: false,
        truncated: true,
        durationMilliseconds: 9,
      });
      const apiRefresh = vi.spyOn(api, 'refresh');
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'api', index: api },
        { name: 'web', index: web },
      ]);
      const signal = new AbortController().signal;

      await expect(index.refresh(signal)).resolves.toEqual({
        root: 'workspace',
        fileCount: 5,
        fromCache: false,
        truncated: true,
        durationMilliseconds: 9,
      });
      expect(apiRefresh).toHaveBeenCalledWith(signal);
    });
  });

  describe(MultiRootWorkspacePathIndex.prototype.dispose, () => {
    it('disposes every folder index', async () => {
      const api = new FixtureIndex('api', 'one.ts', 1);
      const web = new FixtureIndex('web', 'two.ts', 1);
      const apiDispose = vi.spyOn(api, 'dispose');
      const webDispose = vi.spyOn(web, 'dispose');
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'api', index: api },
        { name: 'web', index: web },
      ]);

      await expect(index.dispose()).resolves.toBeUndefined();
      expect(apiDispose).toHaveBeenCalledOnce();
      expect(webDispose).toHaveBeenCalledOnce();
    });

    it('disposes every folder index before reporting all failures together', async () => {
      const api = new FixtureIndex('api', 'one.ts', 1);
      const web = new FixtureIndex('web', 'two.ts', 1);
      const docs = new FixtureIndex('docs', 'three.md', 1);
      const apiFailure = new Error('api stuck');
      const docsFailure = new Error('docs stuck');
      vi.spyOn(api, 'dispose').mockRejectedValue(apiFailure);
      vi.spyOn(docs, 'dispose').mockRejectedValue(docsFailure);
      const webDispose = vi.spyOn(web, 'dispose');
      const index = new MultiRootWorkspacePathIndex('workspace', [
        { name: 'api', index: api },
        { name: 'web', index: web },
        { name: 'docs', index: docs },
      ]);

      const error = await index.dispose().catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({
        message: 'Could not dispose all workspace indexes.',
        errors: [apiFailure, docsFailure],
      });
      expect(webDispose).toHaveBeenCalledOnce();
    });
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
