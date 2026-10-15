import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { MultiRootWorkspaceTextStore } from '#src/workspace/MultiRootWorkspaceTextStore.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(MultiRootWorkspaceTextStore, () => {
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
