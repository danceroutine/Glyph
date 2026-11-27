import { isAbsolute, join, relative, sep } from 'node:path';

/** A physical workspace root can have several editor routes, including routes through an enclosing root. */
export class WorkspaceSourceRoutes {
  constructor(private readonly roots: readonly { name: string; path: string; caseSensitive?: boolean }[]) {}

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
        const path = relative(
          root.caseSensitive === false ? root.path.toLowerCase() : root.path,
          root.caseSensitive === false ? target.toLowerCase() : target,
        );
        return { root, path, spelling: target.slice(root.path.length).split(sep).filter(Boolean).join('/') };
      })
      .filter(({ path }) => contained(path))
      .toSorted((a, b) => b.root.path.length - a.root.path.length)
      .map(({ root, spelling }) => (spelling ? root.name + '/' + spelling : root.name));
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
