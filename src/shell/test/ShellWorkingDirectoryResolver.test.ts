import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectContextKind } from '../../project/context/ProjectContextKind.ts';
import { ShellWorkingDirectoryResolver } from '../ShellWorkingDirectoryResolver.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(ShellWorkingDirectoryResolver, () => {
  describe(ShellWorkingDirectoryResolver.prototype.resolve, () => {
    it('resolves folder and multi-root project directories', async () => {
      const root = await temporaryDirectory();
      await mkdir(join(root, 'packages', 'app'), { recursive: true });
      const folder = new ShellWorkingDirectoryResolver({
        id: 'folder',
        mutationIdentity: 'folder-root',
        kind: ProjectContextKind.FOLDER,
        name: 'Project',
        authority: 'local',
        roots: [{ name: 'Project', path: root }],
      });
      const workspace = new ShellWorkingDirectoryResolver({
        id: 'workspace',
        mutationIdentity: 'workspace-root',
        kind: ProjectContextKind.WORKSPACE,
        name: 'Workspace',
        authority: 'local',
        roots: [{ name: 'app', path: root }],
      });

      const resolvedRoot = await realpath(root);
      await expect(folder.resolve()).resolves.toBe(resolvedRoot);
      await expect(folder.resolve('packages/app')).resolves.toBe(join(resolvedRoot, 'packages', 'app'));
      await expect(workspace.resolve('app/packages/app')).resolves.toBe(join(resolvedRoot, 'packages', 'app'));
    });

    it('rejects absolute paths, missing roots, missing directories, files, and symlink escapes', async () => {
      const root = await temporaryDirectory();
      const outside = await temporaryDirectory();
      await writeFile(join(root, 'file.txt'), 'text');
      await symlink(outside, join(root, 'escape'));
      const folder = new ShellWorkingDirectoryResolver({
        id: 'folder',
        mutationIdentity: 'folder-root',
        kind: ProjectContextKind.FOLDER,
        name: 'Project',
        authority: 'local',
        roots: [{ name: 'Project', path: root }],
      });
      const workspace = new ShellWorkingDirectoryResolver({
        id: 'workspace',
        mutationIdentity: 'workspace-root',
        kind: ProjectContextKind.WORKSPACE,
        name: 'Workspace',
        authority: 'local',
        roots: [{ name: 'app', path: root }],
      });

      await expect(folder.resolve('/tmp')).rejects.toThrow('project-relative');
      await expect(folder.resolve('missing')).rejects.toThrow();
      await expect(folder.resolve('file.txt')).rejects.toThrow('not a directory');
      await expect(folder.resolve('escape')).rejects.toThrow('escapes');
      await expect(workspace.resolve()).rejects.toThrow('select a root');
      await expect(workspace.resolve('missing/path')).rejects.toThrow('must begin with a root name');
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'glyph-shell-root-'));
  temporaryDirectories.push(path);
  return path;
}
