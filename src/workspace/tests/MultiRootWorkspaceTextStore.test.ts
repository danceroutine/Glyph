import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { MultiRootWorkspaceTextStore } from '#src/workspace/MultiRootWorkspaceTextStore.js';
import { EditFailureReason } from '#src/editing/errors/EditFailureReason.js';
import { WorkspaceMutationConsistency } from '#src/workspace/WorkspaceMutationConsistency.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(MultiRootWorkspaceTextStore, () => {
  it.each(['\ud800', '\udc00'])('rejects malformed Unicode workspace qualifiers %j', async name => {
    const root = await fixture();
    expect(
      () =>
        new MultiRootWorkspaceTextStore(
          {
            id: 'workspace',
            mutationIdentity: 'roots',
            kind: ProjectContextKind.WORKSPACE,
            name: 'fixture',
            authority: 'file',
            roots: [{ name, path: root }],
          },
          [{ name, store: new FileSystemWorkspaceTextStore(root) }],
        ),
    ).toThrow();
    const store = workspaceStore(root, root, root);
    await expect(store.read(`api/${name}`)).rejects.toMatchObject({ reason: EditFailureReason.UNSUPPORTED });
    expect(() => store.normalizePath(name)).toThrow();
  });

  it('namespaces discovery and text mutations by workspace folder', async () => {
    const root = await fixture();
    const api = join(root, 'api');
    const web = join(root, 'web');
    await Promise.all([mkdir(join(api, 'src'), { recursive: true }), mkdir(join(web, 'src'), { recursive: true })]);
    await Promise.all([
      writeFile(join(api, 'src', 'server.ts'), 'server\n'),
      writeFile(join(web, 'src', 'app.ts'), 'app\n'),
    ]);
    const store = workspaceStore(root, api, web);

    await expect(store.exists('api/src/server.ts')).resolves.toBe(true);
    await expect(store.exists('web/src/server.ts')).resolves.toBe(false);
    await expect(store.exists('web/src')).resolves.toBe(true);

    await expect(store.list(10, '*.ts')).resolves.toEqual({
      files: ['api/src/server.ts', 'web/src/app.ts'],
      truncated: false,
    });
    await expect(store.list(10, 'web/*.ts')).resolves.toEqual({
      files: ['web/src/app.ts'],
      truncated: false,
    });
    await expect(store.list(10, '*.ts', 'api/src')).resolves.toEqual({
      files: ['api/src/server.ts'],
      truncated: false,
    });
    await expect(store.read('web/src/app.ts')).resolves.toMatchObject({ path: 'web/src/app.ts', text: 'app\n' });

    const created = await store.create('api/src/new.ts', 'new\n', false);
    await store.replace('api/src/new.ts', created.revision, 'updated\n', false);
    expect(await readFile(join(api, 'src', 'new.ts'), 'utf8')).toBe('updated\n');
  });

  it('rejects ambiguous paths and cross-folder renames', async () => {
    const root = await fixture();
    const api = join(root, 'api');
    const web = join(root, 'web');
    await Promise.all([mkdir(api), mkdir(web)]);
    await writeFile(join(api, 'file.txt'), 'value');
    const store = workspaceStore(root, api, web);
    const source = await store.read('api/file.txt');

    await expect(store.read('file.txt')).rejects.toThrow('must begin with one of');
    await expect(store.rename('api/file.txt', 'web/file.txt', source.revision)).rejects.toThrow(
      'across workspace folders',
    );
  });

  it('requires at least one workspace folder', () => {
    const context: ProjectContext = {
      id: 'workspace',
      mutationIdentity: 'roots',
      kind: ProjectContextKind.WORKSPACE,
      name: 'empty',
      authority: 'local',
      roots: [],
    };

    expect(() => new MultiRootWorkspaceTextStore(context, [])).toThrow(
      'A multi-root workspace requires at least one root.',
    );
  });

  it('requires unique workspace folder names', async () => {
    const root = await fixture();
    const context: ProjectContext = {
      id: 'workspace',
      mutationIdentity: 'roots',
      kind: ProjectContextKind.WORKSPACE,
      name: 'duplicate',
      authority: 'local',
      roots: [
        { name: 'api', path: root },
        { name: 'api', path: root },
      ],
    };

    expect(
      () =>
        new MultiRootWorkspaceTextStore(context, [
          { name: 'api', store: new FileSystemWorkspaceTextStore(root) },
          { name: 'api', store: new FileSystemWorkspaceTextStore(root) },
        ]),
    ).toThrow('Workspace folder names must be unique.');
  });

  it('uses the first folder as its root without a workspace file', async () => {
    const root = await fixture();
    const context: ProjectContext = {
      id: 'workspace',
      mutationIdentity: 'roots',
      kind: ProjectContextKind.WORKSPACE,
      name: 'folders',
      authority: 'local',
      roots: [{ name: 'api', path: root }],
    };

    const store = new MultiRootWorkspaceTextStore(context, [
      { name: 'api', store: new FileSystemWorkspaceTextStore(root) },
    ]);

    expect(store.root).toBe(new FileSystemWorkspaceTextStore(root).root);
  });

  it('offers atomic versioned mutations only when every folder does', async () => {
    const root = await fixture();
    const atomic = new FileSystemWorkspaceTextStore(root);
    Object.defineProperty(atomic, 'mutationConsistency', { value: WorkspaceMutationConsistency.ATOMIC_VERSIONED });
    const context: ProjectContext = {
      id: 'workspace',
      mutationIdentity: 'roots',
      kind: ProjectContextKind.WORKSPACE,
      name: 'atomic',
      authority: 'local',
      roots: [{ name: 'api', path: root }],
    };

    const store = new MultiRootWorkspaceTextStore(context, [{ name: 'api', store: atomic }]);

    expect(store.mutationConsistency).toBe(WorkspaceMutationConsistency.ATOMIC_VERSIONED);
    expect(workspaceStore(root, root, root).mutationConsistency).toBe(
      WorkspaceMutationConsistency.BEST_EFFORT_FILESYSTEM,
    );
  });

  describe(MultiRootWorkspaceTextStore.prototype.normalizePath, () => {
    it('accepts a bare workspace folder name', async () => {
      const root = await fixture();

      expect(workspaceStore(root, root, root).normalizePath('web')).toBe('web');
    });

    it('qualifies a normalized path with its workspace folder', async () => {
      const root = await fixture();

      expect(workspaceStore(root, root, root).normalizePath('api/src/../file.ts')).toBe('api/file.ts');
    });

    it.each([
      ['an empty path', ''],
      ['an absolute path', '/api/file.ts'],
      ['a NUL character', 'api/file\0.ts'],
    ])('rejects %s', async (_description, path) => {
      const root = await fixture();

      expect(() => workspaceStore(root, root, root).normalizePath(path)).toThrow(
        expect.objectContaining({
          reason: EditFailureReason.MALFORMED,
          message: 'Workspace paths must begin with a folder name.',
        }),
      );
    });
  });

  describe(MultiRootWorkspaceTextStore.prototype.list, () => {
    it('stops before later folders once the file limit is reached', async () => {
      const root = await fixture();
      const api = join(root, 'api');
      const web = join(root, 'web');
      await Promise.all([mkdir(api), mkdir(web)]);
      await Promise.all([writeFile(join(api, 'one.ts'), 'one'), writeFile(join(web, 'two.ts'), 'two')]);

      await expect(workspaceStore(root, api, web).list(1)).resolves.toEqual({
        files: ['api/one.ts'],
        truncated: true,
      });
    });

    it('lists every file in a folder named by a bare folder pattern', async () => {
      const root = await fixture();
      const api = join(root, 'api');
      const web = join(root, 'web');
      await Promise.all([mkdir(join(web, 'src'), { recursive: true }), mkdir(api)]);
      await Promise.all([writeFile(join(api, 'one.ts'), 'one'), writeFile(join(web, 'src', 'two.md'), 'two')]);

      await expect(workspaceStore(root, api, web).list(10, 'web/')).resolves.toEqual({
        files: ['web/src/two.md'],
        truncated: false,
      });
    });

    it('lists a whole folder named as the target directory', async () => {
      const root = await fixture();
      const api = join(root, 'api');
      const web = join(root, 'web');
      await Promise.all([mkdir(api), mkdir(web)]);
      await Promise.all([writeFile(join(api, 'one.ts'), 'one'), writeFile(join(web, 'two.ts'), 'two')]);

      await expect(workspaceStore(root, api, web).list(10, '*.ts', 'web')).resolves.toEqual({
        files: ['web/two.ts'],
        truncated: false,
      });
    });
  });

  describe(MultiRootWorkspaceTextStore.prototype.readOptional, () => {
    it('qualifies an existing snapshot and returns nothing for a missing file', async () => {
      const root = await fixture();
      const api = join(root, 'api');
      await mkdir(api);
      await writeFile(join(api, 'file.txt'), 'value');
      const store = workspaceStore(root, api, root);

      await expect(store.readOptional('api/file.txt')).resolves.toMatchObject({ path: 'api/file.txt', text: 'value' });
      await expect(store.readOptional('api/missing.txt')).resolves.toBeUndefined();
    });
  });

  describe(MultiRootWorkspaceTextStore.prototype.canonicalPath, () => {
    it('resolves the same file identically through equivalent spellings', async () => {
      const root = await fixture();
      const api = join(root, 'api');
      await mkdir(api);
      const store = workspaceStore(root, api, root);

      await expect(store.canonicalPath('api/src/../file.txt')).resolves.toBe(await store.canonicalPath('api/file.txt'));
    });
  });

  describe(MultiRootWorkspaceTextStore.prototype.rename, () => {
    it('renames a file within one workspace folder', async () => {
      const root = await fixture();
      const api = join(root, 'api');
      await mkdir(api);
      await writeFile(join(api, 'old.txt'), 'value');
      const store = workspaceStore(root, api, root);
      const source = await store.read('api/old.txt');

      await expect(store.rename('api/old.txt', 'api/new.txt', source.revision)).resolves.toMatchObject({
        path: 'api/new.txt',
        text: 'value',
      });
      await expect(readFile(join(api, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe(MultiRootWorkspaceTextStore.prototype.delete, () => {
    it('deletes a file within its workspace folder', async () => {
      const root = await fixture();
      const api = join(root, 'api');
      await mkdir(api);
      await writeFile(join(api, 'file.txt'), 'value');
      const store = workspaceStore(root, api, root);
      const current = await store.read('api/file.txt');

      await store.delete('api/file.txt', current.revision);

      await expect(store.exists('api/file.txt')).resolves.toBe(false);
    });
  });
});

function workspaceStore(root: string, api: string, web: string): MultiRootWorkspaceTextStore {
  const context: ProjectContext = {
    id: 'workspace',
    mutationIdentity: 'workspace-roots',
    kind: ProjectContextKind.WORKSPACE,
    name: 'product',
    authority: 'local',
    workspaceFile: join(root, 'product.code-workspace'),
    roots: [
      { name: 'api', path: api },
      { name: 'web', path: web },
    ],
  };
  return new MultiRootWorkspaceTextStore(context, [
    { name: 'api', store: new FileSystemWorkspaceTextStore(api) },
    { name: 'web', store: new FileSystemWorkspaceTextStore(web) },
  ]);
}

async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'glyph-multi-root-store-'));
  temporaryPaths.push(path);
  return path;
}
