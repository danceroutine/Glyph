import { createHash } from 'node:crypto';
import { AgentInstructionSourceKind } from './AgentInstructionSource.ts';
import type { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
import { posix, win32 } from 'node:path';

/** Logical root names are exact routing keys. Each root owns its filesystem's casing semantics. */
export class InstructionPaths {
  constructor(
    private readonly casing: boolean | ReadonlyMap<string, boolean> = true,
    readonly routes?: WorkspaceSourceRoutes,
    private readonly historicallyInsensitive = process.platform === 'darwin' || process.platform === 'win32',
  ) {}

  sourceIdentity(kind: AgentInstructionSourceKind, path: string) {
    const legacyId = (route: string) => {
      const id = kind + ':' + route;
      return kind === AgentInstructionSourceKind.AGENTS_MD || id.length <= 500
        ? id
        : kind + ':sha256:' + createHash('sha256').update(route).digest('hex');
    };
    const physical = this.routes?.physicalPath(path);
    if (!physical) return { id: legacyId(path) };
    const sensitive = this.caseSensitive(path);
    const key = sensitive ? physical : physical.toLowerCase();
    const physicalId = (value: string) => kind + ':file:' + createHash('sha256').update(value).digest('hex');
    const legacyIds = this.routes!.legacyPaths(path).map(route => legacyId(route));
    if (sensitive && this.historicallyInsensitive) {
      // Earlier versions folded all Mac/Windows names. Disjoint IDs let an ambiguous historical
      // selection fail closed even when one of the two current filenames is already lowercase.
      legacyIds.push(physicalId(physical.toLowerCase()));
      return { id: physicalId('case-sensitive\0' + key), legacyIds };
    }
    return { id: physicalId(key), legacyIds };
  }

  equivalents(path: string): string[] {
    return this.routes?.equivalents(path) ?? [path];
  }

  isWorkspaceRoot(scope: string): boolean {
    return scope === '.' || (typeof this.casing !== 'boolean' && this.casing.has(scope));
  }

  caseSensitive(path: string): boolean {
    return typeof this.casing === 'boolean' ? this.casing : this.casing.get(path.split('/')[0]!) !== false;
  }

  key(path: string): string {
    if (this.caseSensitive(path)) return path;
    if (typeof this.casing === 'boolean') return path.toLowerCase();
    const [root, ...segments] = path.split('/');
    return [root, ...segments.map(segment => segment.toLowerCase())].join('/');
  }

  contains(scope: string, path: string): boolean {
    if (scope === '.') return true;
    const key = this.key(scope);
    return this.equivalents(path).some(route => {
      const target = this.key(route);
      return target === key || target.startsWith(key + '/');
    });
  }

  relativeToScope(scope: string, path: string): string {
    if (scope !== '.') {
      const key = this.key(scope);
      const route = this.equivalents(path).find(
        route => this.key(route) === key || this.key(route).startsWith(key + '/'),
      )!;
      return route.split('/').slice(scope.split('/').length).join('/');
    }
    return typeof this.casing === 'boolean' ? path : path.split('/').slice(1).join('/');
  }

  reference(scope: string, reference: string): string {
    if (
      !reference ||
      win32.isAbsolute(reference) ||
      /^[a-z]:/iu.test(reference) ||
      reference.includes('\\') ||
      reference.includes('\0')
    )
      throw new Error('Rule references must be relative to their workspace root.');
    const [root, ...segments] = scope.split('/');
    const routed = typeof this.casing !== 'boolean';
    const relative = posix.normalize(posix.join(routed ? segments.join('/') : scope, reference));
    if (relative === '..' || relative.startsWith('../')) throw new Error('Rule reference leaves its workspace root.');
    return routed ? posix.join(root!, relative) : relative;
  }
}

export const defaultInstructionPaths = new InstructionPaths();
