import type { FileSearchResult } from './FileSearchResult.ts';
import {
  workspaceContentSearchOptionsSchema,
  type WorkspaceContentSearchOptions,
} from './WorkspaceContentSearchOptions.ts';
import type {
  WorkspaceContentCountResult,
  WorkspaceContentMatch,
  WorkspaceContentSearchResult,
} from './WorkspaceContentSearchResult.ts';
import type { WorkspacePathGlobResult } from './WorkspacePathGlobResult.ts';
import type { WorkspacePathIndex } from './WorkspacePathIndex.ts';
import type { WorkspacePathIndexState } from './WorkspacePathIndexState.ts';

interface NamedWorkspacePathIndex {
  readonly name: string;
  readonly index: WorkspacePathIndex;
}

/** Combines one native index per workspace folder into a namespaced multi-root index. */
export class MultiRootWorkspacePathIndex implements WorkspacePathIndex {
  private readonly indexes: ReadonlyMap<string, WorkspacePathIndex>;

  constructor(
    private readonly contextId: string,
    roots: readonly NamedWorkspacePathIndex[],
  ) {
    if (roots.length === 0) throw new Error('A multi-root workspace requires at least one path index.');
    this.indexes = new Map(roots.map(root => [root.name, root.index]));
    if (this.indexes.size !== roots.length) throw new Error('Workspace folder names must be unique.');
  }

  async initialize(signal?: AbortSignal): Promise<WorkspacePathIndexState> {
    return this.combineStates(await Promise.all([...this.indexes.values()].map(index => index.initialize(signal))));
  }

  async search(
    query: string,
    options: { generation: number; limit?: number; signal?: AbortSignal },
  ): Promise<FileSearchResult> {
    const routed = this.routeQuery(query);
    const indexes = routed ? [[routed.name, this.requireIndex(routed.name)] as const] : [...this.indexes];
    const results = await Promise.all(
      indexes.map(async ([name, index]) => ({ name, result: await index.search(routed?.query ?? query, options) })),
    );
    const limit = options.limit ?? 20;
    const matches = results
      .flatMap(({ name, result }) => {
        // Native match positions count code points, not UTF-16 code units.
        const prefixLength = Array.from(name).length + 1;
        return result.matches.map(match => ({
          ...match,
          path: `${name}/${match.path}`,
          indices: match.indices.map(index => index + prefixLength),
        }));
      })
      .toSorted((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, limit);
    return {
      generation: options.generation,
      query,
      fileCount: results.reduce((sum, entry) => sum + entry.result.fileCount, 0),
      matches,
    };
  }

  async glob(
    pattern: string,
    options: { targetDirectory?: string; limit: number; signal?: AbortSignal },
  ): Promise<WorkspacePathGlobResult> {
    const target =
      options.targetDirectory !== undefined && options.targetDirectory !== ''
        ? this.routePath(options.targetDirectory)
        : undefined;
    const routedPattern = this.routePattern(pattern);
    const candidates = [...this.indexes].filter(
      ([name]) => (!target || target.name === name) && (!routedPattern || routedPattern.name === name),
    );
    const files: string[] = [];
    let truncated = false;
    for (const [name, index] of candidates) {
      if (files.length >= options.limit) {
        truncated = true;
        break;
      }
      const result = await index.glob(routedPattern?.pattern ?? pattern, {
        limit: options.limit - files.length,
        ...(target?.path !== undefined && target?.path !== '' ? { targetDirectory: target.path } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      files.push(...result.files.map(path => `${name}/${path}`));
      truncated ||= result.truncated;
    }
    return { files, truncated };
  }

  async searchContents(pattern: string, options: WorkspaceContentSearchOptions): Promise<WorkspaceContentSearchResult> {
    const { signal, ...serializableOptions } = options;
    const resolved = workspaceContentSearchOptionsSchema.parse(serializableOptions);
    const path = resolved.path !== null && resolved.path !== '' ? this.routePath(resolved.path) : undefined;
    const fileGlob =
      resolved.fileGlob !== null && resolved.fileGlob !== '' ? this.routePattern(resolved.fileGlob) : undefined;
    const candidates = [...this.indexes].filter(
      ([name]) => (!path || path.name === name) && (!fileGlob || fileGlob.name === name),
    );
    const selected: ContentEntry[] = [];
    let skip = resolved.offset;
    // Keep room for response metadata as well as root-qualified JSON entries.
    // Fetch sequentially and discard skipped entries instead of retaining offset
    // pages from every root; the native per-page cap alone is not an aggregate cap.
    let remainingBytes = 512 * 1024 - 1024;
    let searchedFiles = 0;
    let skippedFiles = 0;
    let indexTruncated = false;
    let truncated = false;
    let hasContinuation = false;
    roots: for (const [rootIndex, [name, index]] of candidates.entries()) {
      let offset = 0;
      while (true) {
        signal?.throwIfAborted();
        const page = await index.searchContents(pattern, {
          ...resolved,
          path: (path?.path ?? '') || null,
          fileGlob: fileGlob?.pattern ?? resolved.fileGlob,
          offset,
          limit: Math.min(1000, Math.max(1, skip + resolved.limit - selected.length)),
          ...(signal ? { signal } : {}),
        });
        if (offset === 0) {
          searchedFiles += page.searchedFiles;
          skippedFiles += page.skippedFiles;
        }
        indexTruncated ||= page.indexTruncated;
        for (const entry of prefixEntries(name, page)) {
          if (skip > 0) {
            skip--;
            continue;
          }
          const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (selected.length >= resolved.limit || bytes > remainingBytes) {
            if (selected.length === 0) throw new Error('A content-search entry exceeds the response byte limit.');
            truncated = true;
            hasContinuation = true;
            break roots;
          }
          selected.push(entry);
          remainingBytes -= bytes;
        }
        // A full result is complete even if another page exists. Probing that
        // page can fail or exceed the native offset ceiling and lose valid work.
        if (selected.length === resolved.limit) {
          const laterRoots = rootIndex < candidates.length - 1;
          const nativeCursorValid =
            page.nextOffset !== null &&
            page.nextOffset > offset &&
            workspaceContentSearchOptionsSchema.shape.offset.safeParse(page.nextOffset).success;
          hasContinuation = nativeCursorValid || (laterRoots && (!page.truncated || page.indexTruncated));
          truncated ||= page.truncated || page.nextOffset !== null || laterRoots;
          break roots;
        }
        if (page.nextOffset === null) {
          if (page.truncated) {
            truncated = true;
            // An incomplete index has exhausted its available paths, not the
            // remaining workspace roots. Keep its warning without inventing a
            // continuation for the omitted paths.
            if (!page.indexTruncated) break roots;
          }
          break;
        }
        if (!workspaceContentSearchOptionsSchema.shape.offset.safeParse(page.nextOffset).success) {
          // A partial native page may hit its byte budget before our count
          // limit. Keep collected results when no legal continuation exists.
          truncated = true;
          break roots;
        }
        if (page.nextOffset <= offset) throw new Error('Content search returned a non-advancing page offset.');
        offset = page.nextOffset;
      }
    }
    const nextOffset = resolved.offset + selected.length;
    const canContinue = workspaceContentSearchOptionsSchema.shape.offset.safeParse(nextOffset).success;
    const metadata = {
      searchedFiles,
      skippedFiles,
      indexTruncated,
      truncated,
      nextOffset: hasContinuation && canContinue ? nextOffset : null,
    };
    switch (resolved.outputMode) {
      case 'content':
        return { outputMode: 'content', matches: selected.filter(entry => isContentMatch(entry)), ...metadata };
      case 'files_with_matches':
        return {
          outputMode: 'files_with_matches',
          files: selected.filter(entry => typeof entry === 'string'),
          ...metadata,
        };
      case 'count':
        return { outputMode: 'count', counts: selected.filter(entry => isContentCount(entry)), ...metadata };
    }
    throw new Error('Unsupported content-search output mode.');
  }

  async refresh(signal?: AbortSignal): Promise<WorkspacePathIndexState> {
    return this.combineStates(await Promise.all([...this.indexes.values()].map(index => index.refresh(signal))));
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.indexes.values()].map(index => index.dispose()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0)
      throw new AggregateError(
        failures.map((failure): unknown => failure.reason),
        'Could not dispose all workspace indexes.',
      );
  }

  private combineStates(states: readonly WorkspacePathIndexState[]): WorkspacePathIndexState {
    return {
      root: this.contextId,
      fileCount: states.reduce((sum, state) => sum + state.fileCount, 0),
      fromCache: states.every(state => state.fromCache),
      truncated: states.some(state => state.truncated),
      durationMilliseconds: Math.max(...states.map(state => state.durationMilliseconds)),
    };
  }

  private routeQuery(query: string): { name: string; query: string } | undefined {
    const separator = query.indexOf('/');
    if (separator < 0) return undefined;
    const name = query.slice(0, separator);
    return this.indexes.has(name) ? { name, query: query.slice(separator + 1) } : undefined;
  }

  private routePattern(pattern: string): { name: string; pattern: string } | undefined {
    for (const name of this.indexes.keys()) {
      if (pattern.startsWith(`${name}/`)) return { name, pattern: pattern.slice(name.length + 1) || '**/*' };
    }
    return undefined;
  }

  private routePath(path: string): { name: string; path: string } {
    const separator = path.indexOf('/');
    const name = separator < 0 ? path : path.slice(0, separator);
    this.requireIndex(name);
    return { name, path: separator < 0 ? '' : path.slice(separator + 1) };
  }

  private requireIndex(name: string): WorkspacePathIndex {
    const index = this.indexes.get(name);
    if (!index) throw new Error(`Unknown workspace folder: ${name}`);
    return index;
  }
}

type ContentCount = WorkspaceContentCountResult['counts'][number];
type ContentEntry = WorkspaceContentMatch | ContentCount | string;

function isContentMatch(entry: ContentEntry): entry is WorkspaceContentMatch {
  return typeof entry !== 'string' && !('count' in entry);
}

function isContentCount(entry: ContentEntry): entry is ContentCount {
  return typeof entry !== 'string' && 'count' in entry;
}

function prefixEntries(name: string, result: WorkspaceContentSearchResult): ContentEntry[] {
  switch (result.outputMode) {
    case 'content':
      return result.matches.map(match => ({ ...match, path: `${name}/${match.path}` }));
    case 'files_with_matches':
      return result.files.map(path => `${name}/${path}`);
    case 'count':
      return result.counts.map(count => ({ ...count, path: `${name}/${count.path}` }));
  }
}
