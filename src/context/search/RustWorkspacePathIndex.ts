import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { FileSearchResult } from './FileSearchResult.ts';
import {
  rustWorkspacePathIndexOptionsSchema,
  type ResolvedRustWorkspacePathIndexOptions,
  type RustWorkspacePathIndexOptions,
} from './RustWorkspacePathIndexOptions.ts';
import {
  workspaceContentSearchOptionsSchema,
  type WorkspaceContentSearchOptions,
} from './WorkspaceContentSearchOptions.ts';
import type { WorkspaceContentSearchResult } from './WorkspaceContentSearchResult.ts';
import type { WorkspacePathGlobResult } from './WorkspacePathGlobResult.ts';
import type { WorkspacePathIndex } from './WorkspacePathIndex.ts';
import { WorkspacePathIndexError } from './WorkspacePathIndexError.ts';
import { WorkspacePathIndexFailureReason } from './WorkspacePathIndexFailureReason.ts';
import type { WorkspacePathIndexState } from './WorkspacePathIndexState.ts';

const PROTOCOL_VERSION = 1;
const MAXIMUM_ERROR_OUTPUT = 8_192;

enum PathIndexMethod {
  INITIALIZE = 'initialize',
  SEARCH = 'search',
  GLOB = 'glob',
  CONTENT_SEARCH = 'contentSearch',
  CANCEL = 'cancel',
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

const globResultSchema = z
  .object({
    files: z.array(z.string().min(1)),
    truncated: z.boolean(),
  })
  .strict();

const contentSearchMetadataSchema = {
  searchedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  indexTruncated: z.boolean(),
  truncated: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
};
const contentSearchResultSchema = z.discriminatedUnion('outputMode', [
  z
    .object({
      outputMode: z.literal('content'),
      matches: z.array(
        z
          .object({
            path: z.string().min(1),
            line: z.number().int().positive(),
            column: z.number().int().positive(),
            endLine: z.number().int().positive(),
            endColumn: z.number().int().positive(),
            lineText: z.string(),
            matchedText: z.string(),
            linesBefore: z.array(z.object({ number: z.number().int().positive(), content: z.string() }).strict()),
            linesAfter: z.array(z.object({ number: z.number().int().positive(), content: z.string() }).strict()),
          })
          .strict(),
      ),
      ...contentSearchMetadataSchema,
    })
    .strict(),
  z
    .object({
      outputMode: z.literal('files_with_matches'),
      files: z.array(z.string().min(1)),
      ...contentSearchMetadataSchema,
    })
    .strict(),
  z
    .object({
      outputMode: z.literal('count'),
      counts: z.array(z.object({ path: z.string().min(1), count: z.number().int().nonnegative() }).strict()),
      ...contentSearchMetadataSchema,
    })
    .strict(),
]);

const shutdownResultSchema = z.object({ shutdown: z.literal(true) }).strict();
const failureReasonSchema = z.enum(WorkspacePathIndexFailureReason);

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

/** Persistent JSONL transport for the native cached workspace path index. */
export class RustWorkspacePathIndex implements WorkspacePathIndex {
  private readonly options: ResolvedRustWorkspacePathIndexOptions;
  private readonly processFactory: ProcessFactory;
  private process: SidecarProcess | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private outputBuffer = '';
  private errorOutput = '';
  private initialized: WorkspacePathIndexState | undefined;
  private initializing: Promise<WorkspacePathIndexState> | undefined;
  private disposing: Promise<void> | undefined;
  private disposed = false;

  constructor(options: RustWorkspacePathIndexOptions, processFactory: ProcessFactory = startProcess) {
    const parsed = rustWorkspacePathIndexOptionsSchema.parse(options);
    this.options = {
      ...parsed,
      binaryPath: resolve(parsed.binaryPath),
      root: resolve(parsed.root),
      cachePath: parsed.cachePath === null ? null : resolve(parsed.cachePath),
    };
    this.processFactory = processFactory;
  }

  async initialize(signal?: AbortSignal): Promise<WorkspacePathIndexState> {
    if (this.initialized) return this.initialized;
    if (!this.initializing) {
      const { binaryPath: _, ...configuration } = this.options;
      this.initializing = this.request(PathIndexMethod.INITIALIZE, configuration)
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
        PathIndexMethod.SEARCH,
        {
          query,
          generation: options.generation,
          limit: options.limit,
        },
        options.signal,
      ),
    );
  }

  async glob(
    pattern: string,
    options: { targetDirectory?: string; limit: number; signal?: AbortSignal },
  ): Promise<WorkspacePathGlobResult> {
    if (!this.initialized) await this.initialize(options.signal);
    return globResultSchema.parse(
      await this.request(
        PathIndexMethod.GLOB,
        {
          pattern,
          targetDirectory: options.targetDirectory,
          limit: options.limit,
        },
        options.signal,
      ),
    );
  }

  async searchContents(pattern: string, options: WorkspaceContentSearchOptions): Promise<WorkspaceContentSearchResult> {
    const { signal, ...serializableOptions } = options;
    const resolvedOptions = workspaceContentSearchOptionsSchema.parse(serializableOptions);
    if (!this.initialized) await this.initialize(signal);
    return contentSearchResultSchema.parse(
      await this.request(PathIndexMethod.CONTENT_SEARCH, { pattern, ...resolvedOptions }, signal),
    );
  }

  async refresh(signal?: AbortSignal): Promise<WorkspacePathIndexState> {
    if (!this.initialized) return this.initialize(signal);
    const result = indexStateSchema.parse(await this.request(PathIndexMethod.REFRESH, {}, signal));
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
      shutdownResultSchema.parse(await this.request(PathIndexMethod.SHUTDOWN, {}));
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

  private request(method: PathIndexMethod, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('The workspace path index has been disposed.'));
    if (this.disposing && method !== PathIndexMethod.SHUTDOWN) {
      return Promise.reject(new Error('The workspace path index is shutting down.'));
    }
    if (signal?.aborted) return Promise.reject(toAbortError(signal));
    const process = this.ensureProcess();
    const id = this.nextRequestId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const onAbort = (): void => {
        this.pending.delete(id);
        if (method === PathIndexMethod.CONTENT_SEARCH) this.cancelNativeRequest(id);
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

  private cancelNativeRequest(requestId: number): void {
    if (this.disposed || this.disposing || !this.process) return;
    void this.request(PathIndexMethod.CANCEL, { requestId }).catch(() => {});
  }

  private ensureProcess(): SidecarProcess {
    if (this.process) return this.process;
    const process = this.processFactory(this.options.binaryPath);
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
      this.fail(new Error(`Path-index worker exited (${signal ?? code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`));
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
            `Invalid response from path-index worker: ${error instanceof Error ? error.message : String(error)}`,
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
      const code = parsedCode.success ? parsedCode.data : WorkspacePathIndexFailureReason.INTERNAL;
      const message = typeof error?.message === 'string' ? error.message : 'Native path index failed.';
      pending.reject(new WorkspacePathIndexError(code, message));
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
