import type { FileSearchResult } from './FileSearchResult.ts';
import {
  workspaceContentSearchOptionsSchema,
  type WorkspaceContentSearchOptions,
} from './WorkspaceContentSearchOptions.ts';
import type {
  WorkspaceContentCountResult,
  WorkspaceContentMatchesResult,
  WorkspaceContentSearchResult,
  WorkspaceFilesWithMatchesResult,
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
      .flatMap(({ name, result }) =>
        result.matches.map(match => ({
          ...match,
          path: `${name}/${match.path}`,
          indices: match.indices.map(index => index + name.length + 1),
        })),
      )
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
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
    const target = options.targetDirectory ? this.routePath(options.targetDirectory) : undefined;
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
        ...(target?.path ? { targetDirectory: target.path } : {}),
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
    const path = resolved.path ? this.routePath(resolved.path) : undefined;
    const fileGlob = resolved.fileGlob ? this.routePattern(resolved.fileGlob) : undefined;
    const candidates = [...this.indexes].filter(
      ([name]) => (!path || path.name === name) && (!fileGlob || fileGlob.name === name),
    );
    const desired = resolved.offset + resolved.limit;
    const batches = await Promise.all(
      candidates.map(async ([name, index]) => ({
        name,
        batch: await collect(
          index,
          pattern,
          {
            ...resolved,
            path: path?.path || null,
            fileGlob: fileGlob?.pattern ?? resolved.fileGlob,
            offset: 0,
            ...(signal ? { signal } : {}),
          },
          desired,
        ),
      })),
    );
    const entries = batches.flatMap(({ name, batch }) => prefixEntries(name, batch.result));
    const selected = entries.slice(resolved.offset, resolved.offset + resolved.limit);
    const truncated = entries.length > resolved.offset + selected.length || batches.some(entry => entry.batch.hasMore);
    const metadata = {
      searchedFiles: batches.reduce((sum, entry) => sum + entry.batch.result.searchedFiles, 0),
      skippedFiles: batches.reduce((sum, entry) => sum + entry.batch.result.skippedFiles, 0),
      indexTruncated: batches.some(entry => entry.batch.result.indexTruncated),
      truncated,
      nextOffset: truncated ? resolved.offset + selected.length : null,
    };
    switch (resolved.outputMode) {
      case 'content':
        return { outputMode: 'content', matches: selected as WorkspaceContentMatchesResult['matches'], ...metadata };
      case 'files_with_matches':
        return { outputMode: 'files_with_matches', files: selected as readonly string[], ...metadata };
      case 'count':
        return { outputMode: 'count', counts: selected as WorkspaceContentCountResult['counts'], ...metadata };
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
        failures.map(failure => failure.reason),
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

interface CollectedResult {
  readonly result: WorkspaceContentSearchResult;
  readonly hasMore: boolean;
}

async function collect(
  index: WorkspacePathIndex,
  pattern: string,
  options: WorkspaceContentSearchOptions,
  desired: number,
): Promise<CollectedResult> {
  let offset = 0;
  let first: WorkspaceContentSearchResult | undefined;
  const entries: unknown[] = [];
  let hasMore = false;
  while (entries.length < desired) {
    const page = await index.searchContents(pattern, {
      ...options,
      offset,
      limit: Math.min(1_000, Math.max(1, desired - entries.length)),
    });
    first ??= page;
    entries.push(...resultEntries(page));
    hasMore = page.nextOffset !== null;
    if (!hasMore) break;
    offset = page.nextOffset!;
  }
  const base = first ?? emptyResult(options.outputMode ?? 'content');
  return { result: withEntries(base, entries), hasMore };
}

function prefixEntries(name: string, result: WorkspaceContentSearchResult): unknown[] {
  switch (result.outputMode) {
    case 'content':
      return result.matches.map(match => ({ ...match, path: `${name}/${match.path}` }));
    case 'files_with_matches':
      return result.files.map(path => `${name}/${path}`);
    case 'count':
      return result.counts.map(count => ({ ...count, path: `${name}/${count.path}` }));
  }
}

function resultEntries(result: WorkspaceContentSearchResult): readonly unknown[] {
  switch (result.outputMode) {
    case 'content':
      return result.matches;
    case 'files_with_matches':
      return result.files;
    case 'count':
      return result.counts;
  }
}

function withEntries(result: WorkspaceContentSearchResult, entries: readonly unknown[]): WorkspaceContentSearchResult {
  switch (result.outputMode) {
    case 'content':
      return { ...result, matches: entries as WorkspaceContentMatchesResult['matches'] };
    case 'files_with_matches':
      return { ...result, files: entries as WorkspaceFilesWithMatchesResult['files'] };
    case 'count':
      return { ...result, counts: entries as WorkspaceContentCountResult['counts'] };
  }
}

function emptyResult(outputMode: 'content' | 'files_with_matches' | 'count'): WorkspaceContentSearchResult {
  const metadata = {
    searchedFiles: 0,
    skippedFiles: 0,
    indexTruncated: false,
    truncated: false,
    nextOffset: null,
  };
  switch (outputMode) {
    case 'content':
      return { outputMode, matches: [], ...metadata };
    case 'files_with_matches':
      return { outputMode, files: [], ...metadata };
    case 'count':
      return { outputMode, counts: [], ...metadata };
  }
  throw new Error('Unsupported content-search output mode.');
}
