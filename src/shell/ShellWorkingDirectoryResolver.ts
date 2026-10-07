import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ProjectContext } from '../project/context/ProjectContext.ts';
import { ProjectContextKind } from '../project/context/ProjectContextKind.ts';

/** Resolves project-relative shell directories without permitting root or symlink escapes. */
export class ShellWorkingDirectoryResolver {
  constructor(private readonly context: ProjectContext) {}

  async resolve(input?: string): Promise<string> {
    if (input !== undefined && (isAbsolute(input) || input.includes('\0'))) {
      throw new Error('Shell working directory must be project-relative.');
    }
    const { root, relativePath } = this.selectRoot(input);
    const resolvedRoot = await realpath(root);
    const candidate = await realpath(resolve(resolvedRoot, relativePath));
    const fromRoot = relative(resolvedRoot, candidate);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error('Shell working directory escapes the project root.');
    }
    if (!(await stat(candidate)).isDirectory()) throw new Error('Shell working directory is not a directory.');
    return candidate;
  }

  private selectRoot(input?: string): { root: string; relativePath: string } {
    if (this.context.kind === ProjectContextKind.FOLDER) {
      return { root: this.context.roots[0]!.path, relativePath: input ?? '.' };
    }
    if (!input) throw new Error('A workspace shell command must select a root directory.');
    const [rootName, ...parts] = input.split('/');
    const root = this.context.roots.find(candidate => candidate.name === rootName);
    if (!root) throw new Error(`Workspace shell directory must begin with a root name: ${rootName}.`);
    return { root: root.path, relativePath: parts.join('/') || '.' };
  }
}
