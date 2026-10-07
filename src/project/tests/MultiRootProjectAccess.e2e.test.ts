import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MultiRootWorkspacePathIndex } from '../../context/search/MultiRootWorkspacePathIndex.ts';
import { RustWorkspacePathIndex } from '../../context/search/RustWorkspacePathIndex.ts';
import type { ProjectContext } from '../context/ProjectContext.ts';
import { ProjectContextKind } from '../context/ProjectContextKind.ts';
import { FileSystemWorkspaceTextStore } from '../../workspace/FileSystemWorkspaceTextStore.ts';
import { MultiRootWorkspaceTextStore } from '../../workspace/MultiRootWorkspaceTextStore.ts';
import { ProjectAccess } from '../ProjectAccess.ts';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe(ProjectAccess, () => {
  it('discovers, reads, and searches every repository in a multi-root workspace', async () => {
    const root = await fixture('glyph-multi-root-access-');
    const state = await fixture('glyph-multi-root-index-');
    const apiRoot = join(root, 'api');
    const webRoot = join(root, 'web');
    await Promise.all([
      mkdir(join(apiRoot, 'src'), { recursive: true }),
      mkdir(join(webRoot, 'src'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(apiRoot, 'src', 'server.ts'), 'export const sharedNeedle = "api";\n'),
      writeFile(join(webRoot, 'src', 'App.tsx'), 'export const sharedNeedle = "web";\n'),
    ]);
    const binaryPath = resolve(
      'target',
      'release',
      process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
    );
    const context: ProjectContext = {
      id: 'multi-root-context',
      mutationIdentity: 'multi-root-context-roots',
      kind: ProjectContextKind.WORKSPACE,
      name: 'product',
      authority: 'local',
      workspaceFile: join(root, 'product.code-workspace'),
      roots: [
        { name: 'api', path: apiRoot },
        { name: 'web', path: webRoot },
      ],
    };
    const apiStore = new FileSystemWorkspaceTextStore(apiRoot);
    const webStore = new FileSystemWorkspaceTextStore(webRoot);
    const workspace = new MultiRootWorkspaceTextStore(context, [
      { name: 'api', store: apiStore },
      { name: 'web', store: webStore },
    ]);
    const index = new MultiRootWorkspacePathIndex(context.id, [
      {
        name: 'api',
        index: new RustWorkspacePathIndex({
          binaryPath,
          root: apiRoot,
          cachePath: join(state, 'api.bin'),
          caseSensitive: apiStore.caseSensitive,
        }),
      },
      {
        name: 'web',
        index: new RustWorkspacePathIndex({
          binaryPath,
          root: webRoot,
          cachePath: join(state, 'web.bin'),
          caseSensitive: webStore.caseSensitive,
        }),
      },
    ]);
    const access = new ProjectAccess(apiRoot, {}, workspace, index);

    try {
      await index.initialize();
      await expect(
        execute(access, 'list_project_files', { glob_pattern: '*.{ts,tsx}', target_directory: null }),
      ).resolves.toMatchObject({ files: ['api/src/server.ts', 'web/src/App.tsx'] });
      await expect(
        execute(access, 'read_project_file', {
          path: 'web/src/App.tsx',
          start_line: null,
          end_line: null,
        }),
      ).resolves.toMatchObject({
        path: 'web/src/App.tsx',
        content: expect.stringContaining('1: export const sharedNeedle = "web";'),
      });
      await expect(
        execute(access, 'search_project_contents', {
          pattern: 'sharedNeedle',
          pattern_kind: 'literal',
          path: null,
          file_glob: null,
          file_type: null,
          output_mode: 'files_with_matches',
          lines_before: 0,
          lines_after: 0,
          case_sensitive: true,
          multiline: false,
          limit: 20,
          offset: 0,
        }),
      ).resolves.toMatchObject({ files: ['api/src/server.ts', 'web/src/App.tsx'] });
    } finally {
      await index.dispose();
    }
  }, 30_000);
});

async function execute(access: ProjectAccess, name: string, input: unknown): Promise<Record<string, unknown>> {
  return JSON.parse(await access.execute(name, JSON.stringify(input))) as Record<string, unknown>;
}

async function fixture(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}
