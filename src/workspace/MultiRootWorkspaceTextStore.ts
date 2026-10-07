import { dirname } from 'node:path';
import { EditError } from '../editing/errors/EditError.ts';
import { EditFailureReason } from '../editing/errors/EditFailureReason.ts';
import type { ProjectContext } from '../project/context/ProjectContext.ts';
import type { WorkspaceMutationOptions } from './WorkspaceMutationOptions.ts';
import type { WorkspaceTextSnapshot } from './WorkspaceTextSnapshot.ts';
import type { WorkspaceTextStore } from './WorkspaceTextStore.ts';
import { WorkspaceMutationConsistency } from './WorkspaceMutationConsistency.ts';

interface NamedWorkspaceTextStore {
  readonly name: string;
  readonly store: WorkspaceTextStore;
}

/**
 * Presents multiple workspace folders as one project-relative namespace.
 * Every path begins with its workspace folder name, preventing collisions
 * between repositories while preserving the single-root editing contracts.
 */
export class MultiRootWorkspaceTextStore implements WorkspaceTextStore {
  readonly root: string;
  readonly caseSensitive: boolean;
  readonly mutationConsistency: WorkspaceMutationConsistency;
  private readonly stores: ReadonlyMap<string, WorkspaceTextStore>;

  constructor(context: ProjectContext, roots: readonly NamedWorkspaceTextStore[]) {
    if (roots.length === 0) throw new Error('A multi-root workspace requires at least one root.');
    this.root = context.workspaceFile ? dirname(context.workspaceFile) : roots[0]!.store.root;
    this.caseSensitive = roots.every(root => root.store.caseSensitive);
    this.mutationConsistency = roots.every(
      root => root.store.mutationConsistency === WorkspaceMutationConsistency.ATOMIC_VERSIONED,
    )
      ? WorkspaceMutationConsistency.ATOMIC_VERSIONED
      : WorkspaceMutationConsistency.BEST_EFFORT_FILESYSTEM;
    this.stores = new Map(roots.map(root => [root.name, root.store]));
    if (this.stores.size !== roots.length) throw new Error('Workspace folder names must be unique.');
  }

  normalizePath(input: string): string {
    const route = this.route(input, true);
    if (!route.relativePath) return route.name;
    return this.join(route.name, route.store.normalizePath(route.relativePath));
  }

  async list(
    maxFiles: number,
    globPattern = '**/*',
    targetDirectory?: string,
  ): Promise<{ files: string[]; truncated: boolean }> {
    const target = targetDirectory === undefined ? undefined : this.route(targetDirectory, true);
    const pattern = this.routePattern(globPattern);
    const candidates = [...this.stores].filter(
      ([name]) => (!target || target.name === name) && (!pattern || pattern.name === name),
    );
    const files: string[] = [];
    let truncated = false;
    for (const [name, store] of candidates) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      const result = await store.list(
        maxFiles - files.length,
        pattern?.pattern ?? globPattern,
        target?.relativePath || undefined,
      );
      files.push(...result.files.map(path => this.join(name, path)));
      truncated ||= result.truncated;
    }
    return { files, truncated };
  }

  async read(path: string): Promise<WorkspaceTextSnapshot> {
    const route = this.fileRoute(path);
    return this.prefix(route.name, await route.store.read(route.relativePath));
  }

  async readOptional(path: string): Promise<WorkspaceTextSnapshot | undefined> {
    const route = this.fileRoute(path);
    const snapshot = await route.store.readOptional(route.relativePath);
    return snapshot ? this.prefix(route.name, snapshot) : undefined;
  }

  async create(
    path: string,
    text: string,
    byteOrderMark: boolean,
    mode?: number,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    const route = this.fileRoute(path);
    return this.prefix(route.name, await route.store.create(route.relativePath, text, byteOrderMark, mode, options));
  }

  async replace(
    path: string,
    expectedRevision: string,
    text: string,
    byteOrderMark: boolean,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    const route = this.fileRoute(path);
    return this.prefix(
      route.name,
      await route.store.replace(route.relativePath, expectedRevision, text, byteOrderMark, options),
    );
  }

  async rename(
    source: string,
    target: string,
    expectedRevision: string,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceTextSnapshot> {
    const sourceRoute = this.fileRoute(source);
    const targetRoute = this.fileRoute(target);
    if (sourceRoute.name !== targetRoute.name) {
      throw new EditError(EditFailureReason.UNSUPPORTED, 'Renames across workspace folders are not supported.', {
        path: source,
      });
    }
    return this.prefix(
      sourceRoute.name,
      await sourceRoute.store.rename(sourceRoute.relativePath, targetRoute.relativePath, expectedRevision, options),
    );
  }

  async delete(path: string, expectedRevision: string, options?: WorkspaceMutationOptions): Promise<void> {
    const route = this.fileRoute(path);
    await route.store.delete(route.relativePath, expectedRevision, options);
  }

  private fileRoute(path: string): ReturnType<MultiRootWorkspaceTextStore['route']> {
    const route = this.route(path, false);
    route.store.normalizePath(route.relativePath);
    return route;
  }

  private route(input: string, allowRoot: boolean): { name: string; relativePath: string; store: WorkspaceTextStore } {
    if (!input || input.startsWith('/') || input.includes('\0')) {
      throw new EditError(EditFailureReason.MALFORMED, 'Workspace paths must begin with a folder name.', {
        path: input,
      });
    }
    const separator = input.indexOf('/');
    const name = separator < 0 ? input : input.slice(0, separator);
    const relativePath = separator < 0 ? '' : input.slice(separator + 1);
    const store = this.stores.get(name);
    if (!store || (!allowRoot && !relativePath)) {
      throw new EditError(
        EditFailureReason.MALFORMED,
        `Workspace paths must begin with one of: ${[...this.stores.keys()].join(', ')}.`,
        { path: input },
      );
    }
    return { name, relativePath, store };
  }

  private routePattern(pattern: string): { name: string; pattern: string } | undefined {
    for (const name of this.stores.keys()) {
      if (pattern.startsWith(`${name}/`)) return { name, pattern: pattern.slice(name.length + 1) || '**/*' };
    }
    return undefined;
  }

  private prefix(name: string, snapshot: WorkspaceTextSnapshot): WorkspaceTextSnapshot {
    return { ...snapshot, path: this.join(name, snapshot.path) };
  }

  private join(name: string, path: string): string {
    return `${name}/${path}`;
  }
}
