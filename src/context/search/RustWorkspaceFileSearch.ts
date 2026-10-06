import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { z } from 'zod';
import { FileSearchError } from './FileSearchError.ts';
import { FileSearchFailureReason } from './FileSearchFailureReason.ts';
import type { FileSearchIndexState } from './FileSearchIndexState.ts';
import type { FileSearchResult } from './FileSearchResult.ts';
import type { RustWorkspaceFileSearchOptions } from './RustWorkspaceFileSearchOptions.ts';
import type { WorkspaceFileSearch } from './WorkspaceFileSearch.ts';

const PROTOCOL_VERSION = 1;
const MAXIMUM_ERROR_OUTPUT = 8_192;

enum FileSearchMethod {
  INITIALIZE = 'initialize',
  SEARCH = 'search',
  REFRESH = 'refresh',
  SHUTDOWN = 'shutdown',
}

const indexStateSchema = z
  .object({
    root: z.string(),
    fileCount: z.number().int().nonnegative(),
    fromCache: z.boolean(),
    truncated: z.boolean(),
    durationMilliseconds: z.number().nonnegative(),
  })
  .strict();

const searchResultSchema = z
  .object({
    generation: z.number().int().nonnegative(),
    query: z.string(),
    fileCount: z.number().int().nonnegative(),
    matches: z.array(
      z
        .object({
          path: z.string().min(1),
          score: z.number(),
          indices: z.array(z.number().int().nonnegative()),
        })
        .strict(),
    ),
  })
  .strict();

const shutdownResultSchema = z.object({ shutdown: z.literal(true) }).strict();
const failureReasonSchema = z.enum(FileSearchFailureReason);

interface SidecarProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  removeAbortListener(): void;
}

type ProcessFactory = (binaryPath: string) => SidecarProcess;

/** Persistent JSONL transport for the native `harness-context-index` worker. */
export class RustWorkspaceFileSearch implements WorkspaceFileSearch {
  private readonly processFactory: ProcessFactory;
  private process: SidecarProcess | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private outputBuffer = '';
  private errorOutput = '';
  private initialized: FileSearchIndexState | undefined;
  private initializing: Promise<FileSearchIndexState> | undefined;
  private disposing: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly options: RustWorkspaceFileSearchOptions,
    processFactory: ProcessFactory = startProcess,
  ) {
    this.processFactory = processFactory;
  }

  async initialize(signal?: AbortSignal): Promise<FileSearchIndexState> {
    if (this.initialized) return this.initialized;
    if (!this.initializing) {
      this.initializing = this.request(FileSearchMethod.INITIALIZE, {
        root: resolve(this.options.root),
        ...(this.options.cachePath === undefined ? {} : { cachePath: resolve(this.options.cachePath) }),
        ...(this.options.ignoredDirectories === undefined
          ? {}
          : { ignoredDirectories: [...this.options.ignoredDirectories] }),
        ...(this.options.excludedPaths === undefined ? {} : { excludedPaths: [...this.options.excludedPaths] }),
        ...(this.options.sensitiveFileNames === undefined
          ? {}
          : { sensitiveFileNames: [...this.options.sensitiveFileNames] }),
        ...(this.options.sensitiveFilePrefixes === undefined
          ? {}
          : { sensitiveFilePrefixes: [...this.options.sensitiveFilePrefixes] }),
        ...(this.options.sensitiveFileExtensions === undefined
          ? {}
          : { sensitiveFileExtensions: [...this.options.sensitiveFileExtensions] }),
        ...(this.options.allowedFileNames === undefined
          ? {}
          : { allowedFileNames: [...this.options.allowedFileNames] }),
        ...(this.options.respectGitIgnore === undefined ? {} : { respectGitIgnore: this.options.respectGitIgnore }),
        ...(this.options.maxFiles === undefined ? {} : { maxFiles: this.options.maxFiles }),
      })
        .then(value => {
          const result = indexStateSchema.parse(value);
          this.initialized = result;
          return result;
        })
        .finally(() => {
          this.initializing = undefined;
        });
    }
    return withAbortSignal(this.initializing, signal);
  }

  async search(
    query: string,
    options: { generation: number; limit?: number; signal?: AbortSignal },
  ): Promise<FileSearchResult> {
    if (!this.initialized) await this.initialize(options.signal);
    return searchResultSchema.parse(
      await this.request(
        FileSearchMethod.SEARCH,
        {
          query,
          generation: options.generation,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        },
        options.signal,
      ),
    );
  }

  async refresh(signal?: AbortSignal): Promise<FileSearchIndexState> {
    if (!this.initialized) return this.initialize(signal);
    const result = indexStateSchema.parse(await this.request(FileSearchMethod.REFRESH, {}, signal));
    this.initialized = result;
    return result;
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.disposing) this.disposing = this.shutdown();
    return this.disposing;
  }

  private async shutdown(): Promise<void> {
    const process = this.process;
    if (!process) {
      this.disposed = true;
      return;
    }
    try {
      shutdownResultSchema.parse(await this.request(FileSearchMethod.SHUTDOWN, {}));
      process.stdin.end();
    } catch (error) {
      process.kill('SIGTERM');
      throw error;
    } finally {
      this.disposed = true;
      this.process = undefined;
      this.initialized = undefined;
      this.initializing = undefined;
      this.disposing = undefined;
    }
  }

  private request(method: FileSearchMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('The workspace file search has been disposed.'));
    if (this.disposing && method !== FileSearchMethod.SHUTDOWN) {
      return Promise.reject(new Error('The workspace file search is shutting down.'));
    }
    if (signal?.aborted) return Promise.reject(toAbortError(signal));
    const process = this.ensureProcess();
    const id = this.nextRequestId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        rejectRequest(toAbortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const removeAbortListener = (): void => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, removeAbortListener });
      process.stdin.write(`${JSON.stringify({ version: PROTOCOL_VERSION, id, method, params })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.removeAbortListener();
        pending.reject(error);
      });
    });
  }

  private ensureProcess(): SidecarProcess {
    if (this.process) return this.process;
    const process = this.processFactory(resolve(this.options.binaryPath));
    this.process = process;
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', chunk => this.receive(String(chunk)));
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', chunk => {
      this.errorOutput = `${this.errorOutput}${String(chunk)}`.slice(-MAXIMUM_ERROR_OUTPUT);
    });
    process.once('error', error => {
      if (this.process === process) this.fail(error);
    });
    process.once('exit', (code, signal) => {
      if (this.process !== process) return;
      if (this.disposed && this.pending.size === 0) return;
      const detail = this.errorOutput.trim();
      this.fail(new Error(`File-search worker exited (${signal ?? code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`));
    });
    return process;
  }

  private receive(chunk: string): void {
    this.outputBuffer += chunk;
    for (;;) {
      const end = this.outputBuffer.indexOf('\n');
      if (end < 0) return;
      const line = this.outputBuffer.slice(0, end);
      this.outputBuffer = this.outputBuffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        this.receiveLine(JSON.parse(line) as unknown);
      } catch (error) {
        this.fail(
          new Error(
            `Invalid response from file-search worker: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  }

  private receiveLine(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a response object.');
    const response = value as Record<string, unknown>;
    if (response.version !== PROTOCOL_VERSION || !Number.isSafeInteger(response.id)) {
      throw new Error('Response has an unsupported version or request ID.');
    }
    const id = response.id as number;
    const pending = this.pending.get(id);
    if (!pending) return;
    if (response.error !== undefined) {
      this.pending.delete(id);
      pending.removeAbortListener();
      const error = response.error as Record<string, unknown>;
      const parsedCode = failureReasonSchema.safeParse(error?.code);
      const code = parsedCode.success ? parsedCode.data : FileSearchFailureReason.INTERNAL;
      const message = typeof error?.message === 'string' ? error.message : 'Native file search failed.';
      pending.reject(new FileSearchError(code, message));
      return;
    }
    if (!Object.hasOwn(response, 'result')) {
      throw new Error('Response contains neither a result nor an error.');
    }
    this.pending.delete(id);
    pending.removeAbortListener();
    pending.resolve(response.result);
  }

  private fail(error: Error): void {
    const process = this.process;
    this.process = undefined;
    process?.kill('SIGTERM');
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      request.removeAbortListener();
      request.reject(error);
    }
    this.initialized = undefined;
  }
}

function startProcess(binaryPath: string): SidecarProcess {
  return spawn(binaryPath, [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
}

function toAbortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('File search cancelled.');
}

function withAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(toAbortError(signal));
  return new Promise((resolveOperation, rejectOperation) => {
    const onAbort = (): void => {
      cleanup();
      rejectOperation(toAbortError(signal));
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => {
        cleanup();
        resolveOperation(value);
      },
      error => {
        cleanup();
        rejectOperation(error as Error);
      },
    );
  });
}
