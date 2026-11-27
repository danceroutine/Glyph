import { DirectoryNamePolicies } from './DirectoryNamePolicies.ts';
import {
  normalizeVolumeName,
  type FilesystemNamePolicy,
  type ReadDirectoryNamePolicies,
} from './FilesystemNamePolicy.ts';
import fs, { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/** A physical workspace root can have several editor routes, including routes through an enclosing root. */
export class WorkspaceSourceRoutes {
  private readonly filenameKeys = new Map<string, string>();
  private readonly directories?: DirectoryNamePolicies;
  constructor(
    private readonly roots: readonly {
      name: string;
      path: string;
      caseSensitive?: boolean;
      normalizesUnicode?: boolean;
      foldsUnicode?: boolean;
      uri?: string;
    }[],
    readPolicies?: ReadDirectoryNamePolicies,
  ) {
    if (readPolicies) {
      this.directories = new DirectoryNamePolicies(readPolicies);
      for (const root of roots) {
        if (root.caseSensitive !== undefined && root.normalizesUnicode !== undefined && root.foldsUnicode !== undefined)
          this.directories.remember(root.path, {
            caseSensitive: root.caseSensitive,
            normalizesUnicode: root.normalizesUnicode,
            foldsUnicode: root.foldsUnicode,
          });
      }
    }
  }

  /** Prime all component comparisons together; a synchronous disclosure needs at most one metadata batch. */
  prepare(routes: readonly string[]): void {
    if (!this.directories) return;
    const parents = new Set<string>();
    for (const input of routes) {
      for (const route of this.equivalents(input)) {
        const physical = this.physicalPath(route);
        if (!physical) continue;
        const root = this.rootFor(route)!;
        // An enclosing attachment can add parents above the first, more specific logical root.
        for (let dir = dirname(physical); dir.length >= root.path.length; dir = dirname(dir)) {
          parents.add(dir);
          if (dir === root.path) break;
        }
      }
    }
    this.directories.prepare(parents);
  }

  /** One policy per physical name in this logical route. Root labels belong to the router. */
  componentPolicies(route: string): readonly FilesystemNamePolicy[] | undefined {
    if (!this.directories || !this.physicalPath(route)) return undefined;
    const root = this.rootFor(route)!;
    let parent = root.path;
    return route
      .split('/')
      .slice(this.roots.length === 1 ? 0 : 1)
      .map(segment => {
        const policy = this.directories!.get(parent);
        parent = join(parent, segment);
        return policy;
      });
  }

  /** Confirm a changed comparison key against the owning directory when either spelling already exists. */
  scopeKey(route: string, sensitive: boolean): string | undefined {
    const segments = route.split('/');
    const name = this.roots.length === 1 ? undefined : segments.shift();
    const root = this.roots.length === 1 ? this.roots[0] : this.roots.find(root => root.name === name);
    if (!root || (!this.directories && !root.normalizesUnicode) || !this.physicalPath(route)) return undefined;
    const keys = name === undefined ? [] : [name];
    let parent = root.path;
    for (const segment of segments) {
      const policy = this.directories?.get(parent);
      const normalized = normalizeVolumeName(segment, policy ?? root);
      const key = (policy?.caseSensitive ?? sensitive) ? normalized : normalized.toLowerCase();
      keys.push(segment === key ? key : this.confirmKey(parent, segment, key));
      parent = join(parent, segment);
    }
    return keys.join('/');
  }

  /** Catalog compatibility follows an existing scope directory across every attachment, including bind aliases. */
  physicalScopeKey(route: string): string | undefined {
    const physical = this.physicalPath(route);
    if (!physical) return undefined;
    const info = fs.statSync(physical, { bigint: true, throwIfNoEntry: false });
    return info?.isDirectory() ? '\0' + info.dev + ':' + info.ino : undefined;
  }

  /** Apply only the routed volume's normalization policy. Logical root labels are exact. */
  normalizeName(route: string, value: string): string {
    return normalizeVolumeName(value, this.namePolicy(route));
  }

  namePolicy(route: string): Readonly<Partial<FilesystemNamePolicy>> | undefined {
    return this.rootFor(route);
  }

  /** A single-character glob counts characters in the directory entry's stored spelling. */
  storedSpelling(route: string): string {
    const parts = route.split('/');
    const root = this.roots.length === 1 ? this.roots[0] : this.roots.find(root => root.name === parts[0]);
    const physical = this.physicalPath(route);
    if (!root || (!this.directories && !root.normalizesUnicode) || !physical) return route;
    const tail: string[] = [];
    let prefix = physical;
    const boundary = join(root.path, '.');
    while (prefix !== boundary) {
      try {
        const stored = realpathSync.native(prefix);
        // Retain only a spelling alias. A resolved symlink's unrelated destination is outside this comparison.
        if (this.directories) {
          const storedParts = relative(root.path, stored).split(sep);
          const givenParts = relative(root.path, prefix).split(sep);
          if (storedParts.length !== givenParts.length) return route;
          let parent = root.path;
          for (const [i, segment] of givenParts.entries()) {
            if (segment !== storedParts[i] && this.confirmKey(parent, segment, storedParts[i]!) !== storedParts[i])
              return route;
            parent = join(parent, segment);
          }
        } else if (normalizeVolumeName(stored, root) !== normalizeVolumeName(prefix, root)) return route;
        const segments = stored.split(sep).filter(Boolean).slice(root.path.split(sep).filter(Boolean).length);
        return [...(this.roots.length === 1 ? [] : [root.name]), ...segments, ...tail].join('/');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return route;
        tail.unshift(basename(prefix));
        prefix = dirname(prefix);
      }
    }
    return route;
  }

  physicalPath(route: string) {
    const parts = route.split('/');
    if (parts.includes('..') || route.includes('\\') || isAbsolute(route)) return undefined;
    const name = this.roots.length === 1 ? undefined : parts.shift();
    const root = this.roots.length === 1 ? this.roots[0] : this.roots.find(root => root.name === name);
    if (!root) return undefined;
    return join(root.path, ...parts);
  }

  /** All qualified routes to the same file, most specific attached root first. */
  equivalents(route: string): string[] {
    const target = this.physicalPath(route);
    if (target === undefined || this.roots.length === 1) return [route];
    return this.roots
      .flatMap(root => {
        const key = (value: string) => {
          const normalized = normalizeVolumeName(value, root);
          return root.caseSensitive === false ? normalized.toLowerCase() : normalized;
        };
        const path = relative(key(root.path), key(target));
        if (!this.directories && !contained(path)) return [];
        const depth = root.path.split(sep).filter(Boolean).length;
        const tail = target.split(sep).filter(Boolean).slice(depth);
        const ancestor = tail.reduce(value => dirname(value), target);
        if (this.directories) {
          if (target.split(sep).filter(Boolean).length < depth) return [];
          if (root.path !== ancestor && !this.sameExistingDirectory(root.path, ancestor)) return [];
        } else if (
          root.normalizesUnicode &&
          root.path !== ancestor &&
          this.confirmKey('', root.path, ancestor) !== ancestor
        )
          return [];
        return [{ root, spelling: tail.join('/') }];
      })
      .toSorted((a, b) => b.root.path.length - a.root.path.length)
      .map(({ root, spelling }) => (spelling ? root.name + '/' + spelling : root.name));
  }

  /** Enumerate physical and attached editor URIs for a policy-authorized workspace reference. */
  referenceResources(route: string): { uri: string; caseSensitive: boolean }[] {
    const physical = this.physicalPath(route);
    if (!physical) return [];
    const resources = new Map<string, boolean>();
    for (const alias of this.equivalents(route)) {
      const segments = alias.split('/');
      const root = this.roots.length === 1 ? this.roots[0]! : this.roots.find(root => root.name === segments[0])!;
      if (this.roots.length > 1) segments.shift();
      const sensitive = root.caseSensitive !== false;
      resources.set(pathToFileURL(physical).href, sensitive);
      if (root.uri) resources.set(pathToFileURL(join(fileURLToPath(root.uri), ...segments)).href, sensitive);
    }
    return [...resources].map(([uri, caseSensitive]) => ({ uri, caseSensitive }));
  }

  /** Pick an indexed spelling, retaining required root files ahead of nested files. */
  uniqueFiles(files: readonly string[]): string[] {
    const indexed = new Set(files);
    return [...new Set(files.map(path => this.equivalents(path).find(route => indexed.has(route))!))];
  }

  /** Path-based IDs written by earlier versions in single-root and multi-root workspaces. */
  legacyPaths(route: string): string[] {
    if (this.roots.length === 1) return [route, this.roots[0]!.name + '/' + route];
    return [...new Set(this.equivalents(route).flatMap(path => [path, path.split('/').slice(1).join('/')]))];
  }
  private rootFor(route: string) {
    return this.roots.length === 1 ? this.roots[0] : this.roots.find(root => root.name === route.split('/')[0]);
  }

  private sameExistingDirectory(left: string, right: string): boolean {
    const a = fs.lstatSync(left, { bigint: true, throwIfNoEntry: false });
    const b = fs.lstatSync(right, { bigint: true, throwIfNoEntry: false });
    return a !== undefined && a.dev === b?.dev && a.ino === b.ino;
  }

  private confirmKey(parent: string, segment: string, key: string): string {
    const path = join(parent, segment);
    const comparison = join(parent, key);
    const id = path + '\0' + comparison;
    const cached = this.filenameKeys.get(id);
    if (cached !== undefined) return cached;
    let result = key;
    try {
      const actual = fs.lstatSync(path, { bigint: true, throwIfNoEntry: false });
      const other = fs.lstatSync(comparison, { bigint: true, throwIfNoEntry: false });
      if (actual?.dev !== other?.dev || actual?.ino !== other?.ino)
        result = actual ? '\0' + actual.dev + ':' + actual.ino : '\0' + segment;
    } catch {
      // Project access owns authorization and unavailable-path diagnostics.
      result = segment;
    }
    // Reuse lookups in one synchronous disclosure. A later filesystem operation sees fresh identities.
    if (this.filenameKeys.size === 0)
      queueMicrotask(() => {
        this.filenameKeys.clear();
      });
    this.filenameKeys.set(id, result);
    return result;
  }
}

function contained(path: string) {
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}
