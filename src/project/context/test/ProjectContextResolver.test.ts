import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectContextKind } from '../ProjectContextKind.ts';
import { ProjectContextResolver } from '../ProjectContextResolver.ts';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(ProjectContextResolver, () => {
  it('uses the opened folder itself as the inherited chat context', async () => {
    const root = await fixture();
    const nested = join(root, 'packages', 'app');
    await mkdir(nested, { recursive: true });

    const context = await ProjectContextResolver.folder(nested, 'test');

    expect(context).toMatchObject({
      kind: ProjectContextKind.FOLDER,
      name: 'app',
      authority: 'test',
      roots: [{ name: 'app', path: await realpath(nested) }],
    });
  });

  it('resolves a commented multi-root VS Code workspace with stable named roots', async () => {
    const root = await fixture();
    await Promise.all([mkdir(join(root, 'api')), mkdir(join(root, 'web'))]);
    const manifest = join(root, 'product.code-workspace');
    await writeFile(
      manifest,
      `{
        // Paths are relative to this manifest.
        "folders": [
          { "name": "backend", "path": "api" },
          { "path": "web" },
        ],
        "settings": { "editor.formatOnSave": true },
      }`,
    );

    const first = await ProjectContextResolver.workspace(manifest, root, 'test');
    const second = await ProjectContextResolver.workspace(manifest, root, 'test');

    expect(first).toMatchObject({
      kind: ProjectContextKind.WORKSPACE,
      name: 'product',
      authority: 'test',
      workspaceFile: await realpath(manifest),
      roots: [
        { name: 'backend', path: await realpath(join(root, 'api')) },
        { name: 'web', path: await realpath(join(root, 'web')) },
      ],
    });
    expect(second.id).toBe(first.id);

    await mkdir(join(root, 'docs'));
    await writeFile(
      manifest,
      JSON.stringify({ folders: [{ name: 'backend', path: 'api' }, { path: 'web' }, { path: 'docs' }] }),
    );
    const expanded = await ProjectContextResolver.workspace(manifest, root, 'test');
    expect(expanded.id).toBe(first.id);
    expect(expanded.roots).toHaveLength(3);
  });

  it('rejects malformed manifests and ambiguous folder names', async () => {
    const root = await fixture();
    await Promise.all([mkdir(join(root, 'one')), mkdir(join(root, 'two'))]);
    const malformed = join(root, 'malformed.code-workspace');
    await writeFile(malformed, '{ nope');
    await expect(ProjectContextResolver.workspace(malformed, root)).rejects.toThrow('Could not parse');

    const duplicate = join(root, 'duplicate.code-workspace');
    await writeFile(
      duplicate,
      JSON.stringify({
        folders: [
          { name: 'App', path: 'one' },
          { name: 'app', path: 'two' },
        ],
      }),
    );
    await expect(ProjectContextResolver.workspace(duplicate, root)).rejects.toThrow('duplicate folder name');
  });

  it('resolves a remote workspace URI against the filesystem of the SSH host running Glyph', async () => {
    const root = await fixture();
    const remoteRoot = join(root, 'remote-repository');
    await mkdir(remoteRoot);
    const manifest = join(root, 'remote.code-workspace');
    const uri = `vscode-remote://ssh-remote+example${remoteRoot}`;
    await writeFile(manifest, JSON.stringify({ folders: [{ name: 'remote', uri }] }));

    const context = await ProjectContextResolver.workspace(manifest, root, 'ssh:example');

    expect(context).toMatchObject({
      authority: 'ssh:example',
      roots: [{ name: 'remote', path: await realpath(remoteRoot) }],
    });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glyph-project-context-'));
  temporaryPaths.push(root);
  return root;
}
