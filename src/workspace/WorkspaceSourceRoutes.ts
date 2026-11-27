import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, join, relative, sep } from 'node:path';

/** A physical workspace root can have several editor routes, including routes through an enclosing root. */
export class WorkspaceSourceRoutes {
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

  /** Apply only the routed volume's normalization policy. Logical root labels are exact. */
  normalizeName(route: string, value: string): string {
    const root = this.roots.length === 1 ? this.roots[0] : this.roots.find(root => root.name === route.split('/')[0]);
    return normalizeVolumeName(value, root);
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
      .map(root => {
        const key = (value: string) => {
          const normalized = normalizeVolumeName(value, root);
          return root.caseSensitive === false ? normalized.toLowerCase() : normalized;
        };
        const path = relative(key(root.path), key(target));
        const depth = root.path.split(sep).filter(Boolean).length;
        return { root, path, spelling: target.split(sep).filter(Boolean).slice(depth).join('/') };
      })
      .filter(({ path }) => contained(path))
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
