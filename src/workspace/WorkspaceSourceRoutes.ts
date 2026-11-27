import fs, { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/** A physical workspace root can have several editor routes, including routes through an enclosing root. */
export class WorkspaceSourceRoutes {
  private readonly filenameKeys = new Map<string, string>();
  constructor(
    private readonly roots: readonly {
      name: string;
      path: string;
      caseSensitive?: boolean;
      normalizesUnicode?: boolean;
      foldsUnicode?: boolean;
      uri?: string;
    }[],
  ) {}

  /** Confirm a changed comparison key against the owning directory when either spelling already exists. */
  scopeKey(route: string, sensitive: boolean): string | undefined {
    const segments = route.split('/');
    const name = this.roots.length === 1 ? undefined : segments.shift();
    const root = this.roots.length === 1 ? this.roots[0] : this.roots.find(root => root.name === name);
    if (!root?.normalizesUnicode || !this.physicalPath(route)) return undefined;
    const keys = name === undefined ? [] : [name];
    let parent = root.path;
    for (const segment of segments) {
      const normalized = normalizeVolumeName(segment, root);
      const key = sensitive ? normalized : normalized.toLowerCase();
      keys.push(segment === key ? key : this.confirmKey(parent, segment, key));
      parent = join(parent, segment);
    }
    return keys.join('/');
  }

  /** Apply only the routed volume's normalization policy. Logical root labels are exact. */
  normalizeName(route: string, value: string): string {
    const root = this.roots.length === 1 ? this.roots[0] : this.roots.find(root => root.name === route.split('/')[0]);
    return normalizeVolumeName(value, root);
  }

  /** A single-character glob counts characters in the directory entry's stored spelling. */
  storedSpelling(route: string): string {
    const parts = route.split('/');
    const root = this.roots.length === 1 ? this.roots[0] : this.roots.find(root => root.name === parts[0]);
    const physical = this.physicalPath(route);
    if (!root?.foldsUnicode || !physical) return route;
    const tail: string[] = [];
    let prefix = physical;
    const boundary = join(root.path, '.');
    while (prefix !== boundary) {
      try {
        const stored = realpathSync.native(prefix);
        // Retain only a spelling alias. A resolved symlink's unrelated destination is outside this comparison.
        if (normalizeVolumeName(stored, root) !== normalizeVolumeName(prefix, root)) return route;
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
        if (!contained(path)) return [];
        const depth = root.path.split(sep).filter(Boolean).length;
        const tail = target.split(sep).filter(Boolean).slice(depth);
        const ancestor = tail.reduce(value => dirname(value), target);
        if (root.normalizesUnicode && root.path !== ancestor && this.confirmKey('', root.path, ancestor) !== ancestor)
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

/** Intersection of a physical package with a registered editor root, expressed in that editor's URI space. */
export function projectIntersection(root: { uri: string }, physical: string, directory: string): string | undefined {
  const within = relative(physical, directory);
  if (contained(within)) return pathToFileURL(join(fileURLToPath(root.uri), within)).toString();
  return contained(relative(directory, physical)) ? root.uri : undefined;
}

function contained(path: string) {
  return path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function normalizeVolumeName(value: string, policy?: { normalizesUnicode?: boolean; foldsUnicode?: boolean }): string {
  if (!policy?.normalizesUnicode) return value;
  const normalized = value.normalize('NFC');
  if (!policy.foldsUnicode) return normalized;
  // Map one scalar at a time so Greek sigma is independent of its word position.
  // Default Unicode folding preserves dotless i and expands sharp s and ligatures.
  return Array.from(normalized, char => (char === 'ı' ? char : char.toLowerCase().toUpperCase().toLowerCase()))
    .join('')
    .normalize('NFC');
}
