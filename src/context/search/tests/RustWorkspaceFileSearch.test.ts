import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FileSearchError } from '../FileSearchError.ts';
import { FileSearchFailureReason } from '../FileSearchFailureReason.ts';
import { RustWorkspaceFileSearch } from '../RustWorkspaceFileSearch.ts';

describe(RustWorkspaceFileSearch, () => {
  describe(RustWorkspaceFileSearch.prototype.search, () => {
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
      const search = new RustWorkspaceFileSearch(
        {
          binaryPath: '/bin/harness-context-index',
          root: '/project',
          cachePath: '/cache/index.bin',
          excludedPaths: ['.harness-state', 'logs/provider.jsonl'],
          respectGitIgnore: true,
        },
        () => worker,
      );

      await expect(search.initialize()).resolves.toMatchObject({ fileCount: 2, fromCache: true });
      await expect(search.search('app', { generation: 7, limit: 20 })).resolves.toMatchObject({
        generation: 7,
        matches: [{ path: 'src/App.tsx', indices: [4, 5, 6] }],
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
            excludedPaths: ['.harness-state', 'logs/provider.jsonl'],
            respectGitIgnore: true,
          },
        },
        { version: 1, id: 2, method: 'search', params: { query: 'app', generation: 7, limit: 20 } },
        { version: 1, id: 3, method: 'refresh', params: {} },
        { version: 1, id: 4, method: 'shutdown', params: {} },
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
      const search = new RustWorkspaceFileSearch({ binaryPath: '/bin/index', root: '/project' }, () => worker);

      await expect(search.search('old', { generation: 1 })).rejects.toMatchObject({
        code: FileSearchFailureReason.SUPERSEDED,
        message: 'A newer generation replaced this search.',
      } satisfies Partial<FileSearchError>);
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
