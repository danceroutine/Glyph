import { posix, win32 } from 'node:path';

/** Logical root names are exact routing keys. Each root owns its filesystem's casing semantics. */
export class InstructionPaths {
  constructor(private readonly casing: boolean | ReadonlyMap<string, boolean> = true) {}

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
    const target = this.key(path);
    return target === key || target.startsWith(`${key}/`);
  }

  relativeToScope(scope: string, path: string): string {
    if (scope !== '.') return path.split('/').slice(scope.split('/').length).join('/');
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
