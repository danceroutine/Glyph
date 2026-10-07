import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { RustWorkspacePathIndex } from '../RustWorkspacePathIndex.ts';
import { WorkspacePathIndexError } from '../WorkspacePathIndexError.ts';
import { WorkspacePathIndexFailureReason } from '../WorkspacePathIndexFailureReason.ts';

describe(RustWorkspacePathIndex, () => {
  describe('protocol', () => {
    it('uses the versioned JSONL protocol over one persistent worker', async () => {
      const worker = new FakeWorker(request => {
        switch (request.method) {
          case 'initialize':
            return {
              root: '/project',
              fileCount: 2,
              fromCache: true,
              truncated: false,
              durationMilliseconds: 3,
            };
          case 'search':
            return {
              generation: 7,
              query: 'app',
              fileCount: 2,
              matches: [{ path: 'src/App.tsx', score: 211, indices: [4, 5, 6] }],
            };
          case 'glob':
            return { files: ['src/App.tsx'], truncated: false };
          case 'contentSearch':
            return {
              outputMode: 'content',
              matches: [
                {
                  path: 'src/App.tsx',
                  line: 1,
                  column: 8,
                  endLine: 1,
                  endColumn: 11,
                  lineText: 'export App',
                  matchedText: 'App',
                  linesBefore: [],
                  linesAfter: [],
                },
              ],
              searchedFiles: 1,
              skippedFiles: 0,
              indexTruncated: false,
              truncated: false,
              nextOffset: null,
            };
          case 'refresh':
            return {
              root: '/project',
              fileCount: 3,
              fromCache: false,
              truncated: false,
              durationMilliseconds: 2,
            };
          case 'shutdown':
            return { shutdown: true };
          default:
            throw new Error(`Unexpected method ${request.method}`);
        }
      });
      const search = new RustWorkspacePathIndex(
        {
          binaryPath: '/bin/glyph-context-index',
          root: '/project',
          cachePath: '/cache/index.bin',
          excludedPaths: ['.glyph-state', 'logs/provider.jsonl'],
          respectGitIgnore: true,
          maxContentSearchFileBytes: 9_000_000,
        },
        () => worker,
      );

      await expect(search.initialize()).resolves.toMatchObject({ fileCount: 2, fromCache: true });
      await expect(search.search('app', { generation: 7, limit: 20 })).resolves.toMatchObject({
        generation: 7,
        matches: [{ path: 'src/App.tsx', indices: [4, 5, 6] }],
      });
      await expect(search.glob('*.tsx', { targetDirectory: 'src', limit: 2_000 })).resolves.toEqual({
        files: ['src/App.tsx'],
        truncated: false,
      });
      await expect(
        search.searchContents('App', {
          patternKind: 'literal',
          path: 'src',
          fileGlob: '*.tsx',
          fileType: 'ts',
          outputMode: 'content',
          linesBefore: 1,
          linesAfter: 2,
          caseSensitive: true,
          multiline: false,
          limit: 50,
          offset: 0,
        }),
      ).resolves.toMatchObject({
        outputMode: 'content',
        matches: [{ path: 'src/App.tsx', matchedText: 'App' }],
      });
      await expect(search.refresh()).resolves.toMatchObject({ fileCount: 3, fromCache: false });
      await Promise.all([search.dispose(), search.dispose()]);

      expect(worker.requests).toEqual([
        {
          version: 1,
          id: 1,
          method: 'initialize',
          params: {
            root: '/project',
            cachePath: '/cache/index.bin',
            ignoredDirectories: ['.git', '.next', 'coverage', 'dist', 'node_modules', 'target'],
            excludedPaths: ['.glyph-state', 'logs/provider.jsonl'],
            sensitiveFileNames: ['.git-credentials', '.netrc', '.npmrc', '.pypirc'],
            sensitiveFilePrefixes: ['.env'],
            sensitiveFileExtensions: ['.key', '.pem', '.p12', '.pfx'],
            allowedFileNames: ['.env.example'],
            respectGitIgnore: true,
            maxFiles: 2_000_000,
            maxContentSearchFileBytes: 9_000_000,
            caseSensitive: process.platform !== 'darwin' && process.platform !== 'win32',
          },
        },
        { version: 1, id: 2, method: 'search', params: { query: 'app', generation: 7, limit: 20 } },
        {
          version: 1,
          id: 3,
          method: 'glob',
          params: { pattern: '*.tsx', targetDirectory: 'src', limit: 2_000 },
        },
        {
          version: 1,
          id: 4,
          method: 'contentSearch',
          params: {
            pattern: 'App',
            patternKind: 'literal',
            path: 'src',
            fileGlob: '*.tsx',
            fileType: 'ts',
            outputMode: 'content',
            linesBefore: 1,
            linesAfter: 2,
            caseSensitive: true,
            multiline: false,
            limit: 50,
            offset: 0,
          },
        },
        { version: 1, id: 5, method: 'refresh', params: {} },
        { version: 1, id: 6, method: 'shutdown', params: {} },
      ]);
    });

    it('preserves typed native error codes for superseded searches', async () => {
      const worker = new FakeWorker(request => {
        if (request.method === 'initialize') {
          return { root: '/project', fileCount: 1, fromCache: false, truncated: false, durationMilliseconds: 1 };
        }
        if (request.method === 'shutdown') return { shutdown: true };
        return new NativeFailure('SUPERSEDED', 'A newer generation replaced this search.');
      });
      const search = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);

      await expect(search.search('old', { generation: 1 })).rejects.toMatchObject({
        code: WorkspacePathIndexFailureReason.SUPERSEDED,
        message: 'A newer generation replaced this search.',
      } satisfies Partial<WorkspacePathIndexError>);
      await search.dispose();
    });

    it('resolves content-search defaults before crossing the native boundary', async () => {
      const worker = new FakeWorker(request => {
        if (request.method === 'initialize') {
          return { root: '/project', fileCount: 1, fromCache: false, truncated: false, durationMilliseconds: 1 };
        }
        if (request.method === 'contentSearch') {
          return {
            outputMode: 'content',
            matches: [],
            searchedFiles: 1,
            skippedFiles: 0,
            indexTruncated: false,
            truncated: false,
            nextOffset: null,
          };
        }
        if (request.method === 'shutdown') return { shutdown: true };
        throw new Error(`Unexpected method ${request.method}`);
      });
      const search = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);

      await search.searchContents('needle', {});

      expect(worker.requests[1]).toEqual({
        version: 1,
        id: 2,
        method: 'contentSearch',
        params: {
          pattern: 'needle',
          patternKind: 'regular_expression',
          path: null,
          fileGlob: null,
          fileType: null,
          outputMode: 'content',
          linesBefore: 0,
          linesAfter: 0,
          caseSensitive: true,
          multiline: false,
          limit: 100,
          offset: 0,
        },
      });
      await search.dispose();
    });

    it('cancels an in-flight native content search when its abort signal fires', async () => {
      const worker = new FakeWorker(request => {
        if (request.method === 'initialize') {
          return { root: '/project', fileCount: 1, fromCache: false, truncated: false, durationMilliseconds: 1 };
        }
        if (request.method === 'contentSearch') return NO_RESPONSE;
        if (request.method === 'cancel') return { cancelled: true };
        if (request.method === 'shutdown') return { shutdown: true };
        throw new Error(`Unexpected method ${request.method}`);
      });
      const search = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      await search.initialize();
      const controller = new AbortController();
      const pending = search.searchContents('needle', {
        patternKind: 'literal',
        outputMode: 'files_with_matches',
        linesBefore: 0,
        linesAfter: 0,
        caseSensitive: true,
        multiline: false,
        limit: 20,
        offset: 0,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(worker.requests.some(request => request.method === 'contentSearch')).toBe(true));

      controller.abort(new Error('stop now'));

      await expect(pending).rejects.toThrow('stop now');
      await vi.waitFor(() =>
        expect(worker.requests).toContainEqual({
          version: 1,
          id: 3,
          method: 'cancel',
          params: { requestId: 2 },
        }),
      );
      await search.dispose();
    });
  });
});

interface RequestMessage {
  version: number;
  id: number;
  method: string;
  params: unknown;
}

class NativeFailure {
  constructor(
    readonly code: string,
    readonly message: string,
  ) {}
}

const NO_RESPONSE = Symbol('NO_RESPONSE');

class FakeWorker extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: RequestMessage[] = [];
  readonly stdin: Writable;
  private input = '';

  constructor(private readonly respond: (request: RequestMessage) => unknown) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.input += String(chunk);
        for (;;) {
          const end = this.input.indexOf('\n');
          if (end < 0) break;
          const request = JSON.parse(this.input.slice(0, end)) as RequestMessage;
          this.input = this.input.slice(end + 1);
          this.requests.push(request);
          const result = this.respond(request);
          if (result === NO_RESPONSE) continue;
          const response =
            result instanceof NativeFailure
              ? { version: 1, id: request.id, error: { code: result.code, message: result.message } }
              : { version: 1, id: request.id, result };
          queueMicrotask(() => this.stdout.write(`${JSON.stringify(response)}\n`));
        }
        callback();
      },
    });
  }

  kill(): boolean {
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}
