import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { WorkspacePathIndexError } from '#src/context/search/WorkspacePathIndexError.js';
import { WorkspacePathIndexFailureReason } from '#src/context/search/WorkspacePathIndexFailureReason.js';

describe(RustWorkspacePathIndex, () => {
  describe('protocol', () => {
    it('starts a clean response stream after a worker dies mid-message and ignores late old-worker data', async () => {
      const old = new FakeWorker(() => NO_RESPONSE);
      const next = new FakeWorker(request =>
        request.method === 'shutdown'
          ? { shutdown: true }
          : {
              root: '/project',
              fileCount: 1,
              fromCache: false,
              truncated: false,
              durationMilliseconds: 1,
            },
      );
      let starts = 0;
      const index = new RustWorkspacePathIndex({ binaryPath: '/fixture', root: '/project', cachePath: '/cache' }, () =>
        starts++ === 0 ? old : next,
      );
      const initial = index.initialize().catch((error: unknown) => error);
      old.stdout.write('{"version":');
      old.emit('exit', 1, null);
      await initial;
      try {
        const replacement = index.initialize();
        old.stdout.write('late broken response\n');
        await expect(replacement).resolves.toMatchObject({ fileCount: 1 });
      } finally {
        await index.dispose();
      }
    });
    it('consumes worker stdin errors and rejects outstanding requests instead of crashing the host', async () => {
      const worker = new FakeWorker(() => NO_RESPONSE);
      const index = new RustWorkspacePathIndex(
        { binaryPath: '/fixture', root: '/project', cachePath: '/cache' },
        () => worker,
      );
      const pending = index.initialize().catch((error: unknown) => error);
      try {
        expect(() => worker.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
        expect(await pending).toMatchObject({ message: 'EPIPE' });
      } finally {
        worker.emit('error', new Error('fixture cleanup'));
        await pending;
        await index.dispose();
      }
    });

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
            ignoredDirectories: [
              '.artifacts',
              '.code-oss',
              '.git',
              '.next',
              'coverage',
              'dist',
              'node_modules',
              'target',
            ],
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

    it.each(['unavailable', 'cancelled', 'oversized'] as const)(
      'does not fall back to disk after %s editor snapshots and permits a later search',
      async failure => {
        const worker = new FakeWorker(request => {
          if (request.method === 'initialize')
            return { root: '/project', fileCount: 1, fromCache: false, truncated: false, durationMilliseconds: 1 };
          if (request.method === 'contentSearch')
            return {
              outputMode: 'content',
              matches: [],
              searchedFiles: 1,
              skippedFiles: 0,
              indexTruncated: false,
              truncated: false,
              nextOffset: null,
            };
          if (request.method === 'shutdown') return { shutdown: true };
          throw new Error(`Unexpected method ${request.method}`);
        });
        const controller = new AbortController();
        const readContentOverrides = vi.fn(async (): Promise<Readonly<Record<string, string>>> => {
          if (failure === 'unavailable') throw new Error('Snapshot unavailable');
          if (failure === 'cancelled') controller.abort(new Error('Search stopped'));
          return { 'a.ts': failure === 'oversized' ? 'x'.repeat(900 * 1024) : 'late text' };
        });
        const index = new RustWorkspacePathIndex(
          { binaryPath: '/bin/index', root: '/project', readContentOverrides },
          () => worker,
        );
        try {
          await expect(index.searchContents('needle', { signal: controller.signal })).rejects.toThrow(
            failure === 'unavailable'
              ? 'Snapshot unavailable'
              : failure === 'cancelled'
                ? 'Search stopped'
                : 'request budget',
          );
          expect(worker.requests.map(request => request.method)).toEqual(['initialize']);
          readContentOverrides.mockResolvedValue({ 'a.ts': '' });
          await expect(index.searchContents('needle', {})).resolves.toMatchObject({ matches: [] });
          expect(worker.requests.at(-1)).toMatchObject({
            method: 'contentSearch',
            params: { overrides: { 'a.ts': '' } },
          });
        } finally {
          await index.dispose();
        }
      },
    );

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
      await vi.waitFor(() => {
        expect(worker.requests.some(request => request.method === 'contentSearch')).toBe(true);
      });

      controller.abort(new Error('stop now'));

      await expect(pending).rejects.toThrow('stop now');
      await vi.waitFor(() => {
        expect(worker.requests).toContainEqual({
          version: 1,
          id: 3,
          method: 'cancel',
          params: { requestId: 2 },
        });
      });
      await search.dispose();
    });
  });

  describe(RustWorkspacePathIndex.prototype.initialize, () => {
    it('shares one native initialization across concurrent callers and reuses its state afterwards', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : indexState(1)));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      const [first, second] = await Promise.all([index.initialize(), index.initialize()]);
      const third = await index.initialize();

      expect(second).toEqual(first);
      expect(third).toBe(first);
      expect(worker.requests.map(request => request.method)).toEqual(['initialize']);
    });

    it('rejects immediately with the abort reason when the signal is already aborted', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : indexState(1)));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());
      const controller = new AbortController();
      controller.abort(new Error('not now'));

      await expect(index.initialize(controller.signal)).rejects.toThrow('not now');
    });

    it('rejects with the abort reason when the signal fires while the worker is still indexing', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : NO_RESPONSE));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());
      const controller = new AbortController();

      const pending = index.initialize(controller.signal);
      controller.abort(new Error('user left'));

      await expect(pending).rejects.toThrow('user left');
    });

    it('reports a generic cancellation when the abort reason is not an error', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : NO_RESPONSE));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());
      const controller = new AbortController();

      const pending = index.initialize(controller.signal);
      controller.abort('user left');

      await expect(pending).rejects.toThrow('File search cancelled.');
    });

    it('propagates a native initialization failure to a caller observing an abort signal', async () => {
      const worker = new FakeWorker(request =>
        request.method === 'shutdown' ? { shutdown: true } : new NativeFailure('INITIALIZATION_FAILED', 'No root.'),
      );
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      await expect(index.initialize(new AbortController().signal)).rejects.toMatchObject({
        code: WorkspacePathIndexFailureReason.INITIALIZATION_FAILED,
        message: 'No root.',
      });
    });

    it('fails when the configured worker binary cannot be started', async () => {
      const root = await mkdtemp(join(tmpdir(), 'glyph-path-index-missing-'));
      onTestFinished(() => rm(root, { recursive: true, force: true }));
      const index = new RustWorkspacePathIndex({ binaryPath: join(root, 'missing-binary'), root });
      onTestFinished(() => index.dispose());

      await expect(index.initialize()).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe(RustWorkspacePathIndex.prototype.search, () => {
    it('rejects with a generic cancellation when its signal was already aborted without an error', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : indexState(1)));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());
      await index.initialize();
      const controller = new AbortController();
      controller.abort('stop');

      await expect(index.search('app', { generation: 1, signal: controller.signal })).rejects.toThrow(
        'File search cancelled.',
      );
      expect(worker.requests.map(request => request.method)).toEqual(['initialize']);
    });

    it('abandons an in-flight path search locally without asking the worker to cancel it', async () => {
      const worker = new FakeWorker(request => {
        if (request.method === 'initialize') return indexState(1);
        if (request.method === 'shutdown') return { shutdown: true };
        return NO_RESPONSE;
      });
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());
      await index.initialize();
      const controller = new AbortController();

      const pending = index.search('app', { generation: 1, signal: controller.signal });
      controller.abort(new Error('typing continued'));

      await expect(pending).rejects.toThrow('typing continued');
      expect(worker.requests.map(request => request.method)).toEqual(['initialize', 'search']);
    });

    it('rejects new searches while the index is shutting down', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : indexState(1)));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      await index.initialize();

      const disposal = index.dispose();
      const search = index.search('app', { generation: 1 });

      await expect(search).rejects.toThrow('The workspace path index is shutting down.');
      await disposal;
    });

    it('rejects searches after the index has been disposed', async () => {
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => {
        throw new Error('A disposed index must not start a worker.');
      });
      await index.dispose();

      await expect(index.search('app', { generation: 1 })).rejects.toThrow(
        'The workspace path index has been disposed.',
      );
    });
  });

  describe(RustWorkspacePathIndex.prototype.glob, () => {
    it('initializes the index before the first glob', async () => {
      const worker = new FakeWorker(request => {
        if (request.method === 'initialize') return indexState(1);
        if (request.method === 'glob') return { files: ['src/App.tsx'], truncated: false };
        return { shutdown: true };
      });
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      await expect(index.glob('**/*.tsx', { limit: 10 })).resolves.toEqual({
        files: ['src/App.tsx'],
        truncated: false,
      });
      expect(worker.requests.map(request => request.method)).toEqual(['initialize', 'glob']);
    });
  });

  describe(RustWorkspacePathIndex.prototype.filterPaths, () => {
    it('initializes once and then intersects candidate paths with the catalog', async () => {
      const worker = new FakeWorker(request => {
        if (request.method === 'initialize') return indexState(2);
        if (request.method === 'filterPaths') return ['src/App.tsx'];
        return { shutdown: true };
      });
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      await expect(index.filterPaths(['src/App.tsx', '.env'])).resolves.toEqual(['src/App.tsx']);
      await expect(index.filterPaths(['src/App.tsx'])).resolves.toEqual(['src/App.tsx']);
      expect(worker.requests.map(request => [request.method, request.params])).toEqual([
        ['initialize', expect.anything()],
        ['filterPaths', ['src/App.tsx', '.env']],
        ['filterPaths', ['src/App.tsx']],
      ]);
    });
  });

  describe(RustWorkspacePathIndex.prototype.refresh, () => {
    it('initializes instead of refreshing an index that was never initialized', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : indexState(4)));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      await expect(index.refresh()).resolves.toMatchObject({ fileCount: 4 });
      expect(worker.requests.map(request => request.method)).toEqual(['initialize']);
    });
  });

  describe(RustWorkspacePathIndex.prototype.searchContents, () => {
    it('does not ask a shutting-down worker to cancel an abandoned content search', async () => {
      const worker = new FakeWorker(request => {
        if (request.method === 'initialize') return indexState(1);
        if (request.method === 'shutdown') return { shutdown: true };
        return NO_RESPONSE;
      });
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      await index.initialize();
      const controller = new AbortController();
      const pending = index.searchContents('needle', { signal: controller.signal });
      await vi.waitFor(() => {
        expect(worker.requests.map(request => request.method)).toContain('contentSearch');
      });

      const disposal = index.dispose();
      controller.abort(new Error('closing'));

      await expect(pending).rejects.toThrow('closing');
      await disposal;
      expect(worker.requests.map(request => request.method)).toEqual(['initialize', 'contentSearch', 'shutdown']);
    });

    it('tolerates the worker failing to cancel an abandoned content search', async () => {
      const worker = new FakeWorker(request => {
        if (request.method === 'initialize') return indexState(1);
        if (request.method === 'cancel') return new NativeFailure('INVALID_REQUEST', 'Unknown request.');
        if (request.method === 'shutdown') return { shutdown: true };
        return NO_RESPONSE;
      });
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      await index.initialize();
      const controller = new AbortController();
      const pending = index.searchContents('needle', { signal: controller.signal });
      await vi.waitFor(() => {
        expect(worker.requests.map(request => request.method)).toContain('contentSearch');
      });

      controller.abort(new Error('stop'));

      await expect(pending).rejects.toThrow('stop');
      await expect(index.dispose()).resolves.toBeUndefined();
      expect(worker.requests.map(request => request.method)).toEqual([
        'initialize',
        'contentSearch',
        'cancel',
        'shutdown',
      ]);
    });
  });

  describe(RustWorkspacePathIndex.prototype.dispose, () => {
    it('resolves repeated disposal after the worker has shut down', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : indexState(1)));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      await index.initialize();

      await index.dispose();
      await index.dispose();

      expect(worker.requests.map(request => request.method)).toEqual(['initialize', 'shutdown']);
    });

    it('terminates the worker and reports the failure when it refuses to shut down', async () => {
      const worker = new FakeWorker(request =>
        request.method === 'shutdown' ? new NativeFailure('INTERNAL', 'Busy.') : indexState(1),
      );
      const kill = vi.spyOn(worker, 'kill');
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      await index.initialize();

      await expect(index.dispose()).rejects.toMatchObject({
        code: WorkspacePathIndexFailureReason.INTERNAL,
        message: 'Busy.',
      });
      await expect(index.dispose()).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('worker transport', () => {
    it('ignores blank lines and responses for requests it is not waiting on', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : NO_RESPONSE));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      const pending = index.initialize();
      worker.stdout.write('\n   \n');
      worker.stdout.write(`${JSON.stringify({ version: 1, id: 99, result: indexState(7) })}\n`);
      worker.stdout.write(`${JSON.stringify({ version: 1, id: 1, result: indexState(3) })}\n`);

      await expect(pending).resolves.toMatchObject({ fileCount: 3 });
    });

    it.each([
      ['a null response', 'null', 'Expected a response object.'],
      ['a scalar response', '42', 'Expected a response object.'],
      ['an array response', '[]', 'Expected a response object.'],
      ['an unsupported version', '{"version":2,"id":1,"result":{}}', 'unsupported version or request ID'],
      ['a fractional request ID', '{"version":1,"id":1.5,"result":{}}', 'unsupported version or request ID'],
      ['neither a result nor an error', '{"version":1,"id":1}', 'Response contains neither a result nor an error.'],
      ['malformed JSON', '{"version":', 'Invalid response from path-index worker: '],
    ])('fails outstanding requests when the worker sends %s', async (_description, line, message) => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : NO_RESPONSE));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      const pending = index.initialize();
      worker.stdout.write(`${line}\n`);

      await expect(pending).rejects.toThrow(message);
    });

    it('describes a non-error parser failure in the invalid response', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : NO_RESPONSE));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());
      const parse = JSON.parse;
      const spy = vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: Parameters<JSON['parse']>[1]) => {
        if (text === 'poison') throw 'parser exploded';
        const parsed: unknown = parse(text, reviver);
        return parsed;
      });
      onTestFinished(() => {
        spy.mockRestore();
      });

      const pending = index.initialize();
      worker.stdout.write('poison\n');

      await expect(pending).rejects.toThrow('Invalid response from path-index worker: parser exploded');
    });

    it.each([
      ['an unknown code and a non-string message', { code: 'EXPLODED', message: 7 }],
      ['a null error payload', null],
    ])('reports a native error with %s as a generic internal failure', async (_description, error) => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : NO_RESPONSE));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      const pending = index.initialize();
      worker.stdout.write(`${JSON.stringify({ version: 1, id: 1, error })}\n`);

      await expect(pending).rejects.toMatchObject({
        code: WorkspacePathIndexFailureReason.INTERNAL,
        message: 'Native path index failed.',
      });
    });

    it('includes recent worker diagnostics when the worker exits unexpectedly', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : NO_RESPONSE));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      const pending = index.initialize();
      const diagnostics = once(worker.stderr, 'data');
      worker.stderr.write('  panic: index corrupted  \n');
      await diagnostics;
      worker.emit('exit', null, null);

      await expect(pending).rejects.toThrow('Path-index worker exited (unknown). panic: index corrupted');
    });

    it('ignores diagnostics and stream failures from a worker that already exited', async () => {
      const old = new FakeWorker(() => NO_RESPONSE);
      const next = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : indexState(1)));
      let starts = 0;
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () =>
        starts++ === 0 ? old : next,
      );
      onTestFinished(() => index.dispose());
      const initial = index.initialize();
      old.emit('exit', 2, null);
      await expect(initial).rejects.toThrow('Path-index worker exited (2).');

      const replacement = index.initialize();
      const diagnostics = once(old.stderr, 'data');
      old.stderr.write('stale diagnostics\n');
      await diagnostics;
      old.stdin.emit('error', new Error('stale pipe'));

      await expect(replacement).resolves.toMatchObject({ fileCount: 1 });
    });

    it('ignores the worker exiting once the index has been disposed', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : indexState(1)));
      const kill = vi.spyOn(worker, 'kill');
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());
      await index.initialize();
      (index as unknown as { disposed: boolean }).disposed = true;

      worker.emit('exit', 0, null);

      expect(kill).not.toHaveBeenCalled();
      await expect(index.initialize()).resolves.toMatchObject({ fileCount: 1 });
    });

    it('fails outstanding requests when the current worker process reports an error', async () => {
      const worker = new FakeWorker(request => (request.method === 'shutdown' ? { shutdown: true } : NO_RESPONSE));
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      onTestFinished(() => index.dispose());

      const pending = index.initialize();
      worker.emit('error', new Error('spawn EACCES'));

      await expect(pending).rejects.toThrow('spawn EACCES');
    });

    it('rejects a request whose message cannot be written to the worker', async () => {
      const worker = new UnwritableWorker();
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);

      const pending = index.initialize();
      worker.completeWrite(0, new Error('EPIPE'));

      await expect(pending).rejects.toThrow('EPIPE');
    });

    it('ignores a late write failure for a request that was already abandoned', async () => {
      const worker = new UnwritableWorker();
      const index = new RustWorkspacePathIndex({ binaryPath: '/bin/index', root: '/project' }, () => worker);
      const initialized = index.initialize();
      worker.completeWrite(0);
      worker.stdout.write(`${JSON.stringify({ version: 1, id: 1, result: indexState(1) })}\n`);
      await initialized;
      const controller = new AbortController();
      const search = index.search('app', { generation: 1, signal: controller.signal });
      await vi.waitFor(() => {
        expect(worker.writes).toBe(2);
      });

      controller.abort(new Error('abandoned'));
      await expect(search).rejects.toThrow('abandoned');
      const failure = once(worker.stdin, 'error');
      worker.completeWrite(1, new Error('EPIPE'));

      await expect(failure).resolves.toEqual([expect.objectContaining({ message: 'EPIPE' })]);
    });
  });
});

function indexState(fileCount: number) {
  return { root: '/project', fileCount, fromCache: false, truncated: false, durationMilliseconds: 1 };
}

class UnwritableWorker extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  private readonly callbacks: ((error?: Error | null) => void)[] = [];

  constructor() {
    super();
    this.stdin = new Writable({
      write: (_chunk, _encoding, callback) => {
        this.callbacks.push(callback);
      },
    });
  }

  get writes(): number {
    return this.callbacks.length;
  }

  completeWrite(index: number, error?: Error): void {
    this.callbacks[index]!(error ?? null);
  }

  kill(): boolean {
    return true;
  }
}

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
          queueMicrotask(() => {
            this.stdout.write(`${JSON.stringify(response)}\n`);
          });
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
