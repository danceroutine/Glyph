import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { ProjectContextResolver } from '#src/project/context/ProjectContextResolver.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('ProjectContextResolver', () => {
  it.each(['local', 'ssh:this-host'])(
    'rejects remote folder URIs rather than reusing their local pathname under %s',
    async authority => {
      const root = await fixture();
      const manifest = join(root, 'remote.code-workspace');
      await writeFile(manifest, JSON.stringify({ folders: [{ uri: `vscode-remote://ssh-remote+other-host${root}` }] }));
      await expect(ProjectContextResolver.workspace(manifest, root, authority)).rejects.toThrow(/unsupported.*URI/iu);
    },
  );
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

    await writeFile(manifest, JSON.stringify({ folders: [{ path: 'web' }, { name: 'backend', path: 'api' }] }));
    const reordered = await ProjectContextResolver.workspace(manifest, root, 'test');
    expect(reordered.mutationIdentity).toBe(first.mutationIdentity);

    await mkdir(join(root, 'docs'));
    await writeFile(
      manifest,
      JSON.stringify({ folders: [{ name: 'backend', path: 'api' }, { path: 'web' }, { path: 'docs' }] }),
    );
    const expanded = await ProjectContextResolver.workspace(manifest, root, 'test');
    expect(expanded.id).toBe(first.id);
    expect(expanded.mutationIdentity).not.toBe(first.mutationIdentity);
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

  it('requires a real remote filesystem binding even when the supplied authority resembles the URI host', async () => {
    const root = await fixture();
    const remoteRoot = join(root, 'remote-repository');
    await mkdir(remoteRoot);
    const manifest = join(root, 'remote.code-workspace');
    const uri = `vscode-remote://ssh-remote+example${remoteRoot}`;
    await writeFile(manifest, JSON.stringify({ folders: [{ name: 'remote', uri }] }));

    await expect(ProjectContextResolver.workspace(manifest, root, 'ssh:example')).rejects.toThrow(
      'unsupported folder URI',
    );
  });

  it('resolves a local file URI folder to its canonical directory', async () => {
    const root = await fixture();
    await mkdir(join(root, 'local'));
    const manifest = join(root, 'local.code-workspace');
    await writeFile(manifest, JSON.stringify({ folders: [{ uri: pathToFileURL(join(root, 'local')).href }] }));

    const context = await ProjectContextResolver.workspace(manifest, root, 'test');

    expect(context.roots).toEqual([{ name: 'local', path: await realpath(join(root, 'local')) }]);
  });

  it('rejects a manifest that parses but does not describe any folders', async () => {
    const root = await fixture();
    const manifest = join(root, 'empty.code-workspace');
    await writeFile(manifest, JSON.stringify({ folders: [] }));

    await expect(ProjectContextResolver.workspace(manifest, root, 'test')).rejects.toThrow(
      `Invalid workspace file ${await realpath(manifest)}:`,
    );
  });

  it('rejects a folder entry that names a file instead of a directory', async () => {
    const root = await fixture();
    await writeFile(join(root, 'file.txt'), 'not a directory');
    const manifest = join(root, 'file.code-workspace');
    await writeFile(manifest, JSON.stringify({ folders: [{ path: 'file.txt' }] }));

    await expect(ProjectContextResolver.workspace(manifest, root, 'test')).rejects.toThrow(
      `Project root is not a directory: ${await realpath(join(root, 'file.txt'))}`,
    );
  });

  it.each([
    ['a blank name', '   '],
    ['a path separator', 'one/two'],
    ['a control character', 'one\u0007'],
  ])('rejects a folder name containing %s', async (_description, name) => {
    const root = await fixture();
    await mkdir(join(root, 'one'));
    const manifest = join(root, 'names.code-workspace');
    await writeFile(manifest, JSON.stringify({ folders: [{ name, path: 'one' }] }));

    await expect(ProjectContextResolver.workspace(manifest, root, 'test')).rejects.toThrow(
      'contains an invalid folder name',
    );
  });

  describe(ProjectContextResolver.resolve, () => {
    it('resolves the current directory as a folder context when no workspace file is given', async () => {
      const root = await fixture();

      const context = await ProjectContextResolver.resolve({ currentDirectory: root, authority: 'test' });

      expect(context).toMatchObject({
        kind: ProjectContextKind.FOLDER,
        authority: 'test',
        roots: [{ path: await realpath(root) }],
      });
    });

    it('resolves a workspace file relative to the current directory', async () => {
      const root = await fixture();
      await mkdir(join(root, 'api'));
      await writeFile(join(root, 'product.code-workspace'), JSON.stringify({ folders: [{ path: 'api' }] }));

      const context = await ProjectContextResolver.resolve({
        currentDirectory: root,
        workspaceFile: 'product.code-workspace',
        authority: 'test',
      });

      expect(context).toMatchObject({
        kind: ProjectContextKind.WORKSPACE,
        name: 'product',
        roots: [{ name: 'api', path: await realpath(join(root, 'api')) }],
      });
    });

    it('defaults to the local authority outside an SSH session', async () => {
      const root = await fixture();
      vi.stubEnv('SSH_CONNECTION', '');
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });

      const context = await ProjectContextResolver.resolve({ currentDirectory: root });

      expect(context.authority).toBe('local');
    });

    it('defaults to an SSH authority naming this host inside an SSH session', async () => {
      const root = await fixture();
      vi.stubEnv('SSH_CONNECTION', '192.0.2.1 50000 192.0.2.2 22');
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });

      const context = await ProjectContextResolver.resolve({ currentDirectory: root });

      expect(context.authority).toBe(`ssh:${hostname()}`);
    });
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'glyph-project-context-'));
  temporaryPaths.push(root);
  return root;
}
