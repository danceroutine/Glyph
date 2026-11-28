import type { ToolExecutionContext } from '#src/tools/ToolExecutionContext.js';
import { NativeFilesystemMetadata } from '#src/workspace/NativeFilesystemMetadata.js';
import { NativePinnedSourceAuthority } from '#src/workspace/PinnedSourceAuthority.js';
import { WorkspaceAccessPolicy } from '#src/workspace/policy/WorkspaceAccessPolicy.js';
import { fixtureWorkspace, fixtureIndex } from '#src/workspace/tests/fixtures/workspaceAccess.js';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultiRootWorkspacePathIndex } from '#src/context/search/MultiRootWorkspacePathIndex.js';
import type { ProjectContext } from '#src/project/context/ProjectContext.js';
import { ProjectContextKind } from '#src/project/context/ProjectContextKind.js';
import { MultiRootWorkspaceTextStore } from '#src/workspace/MultiRootWorkspaceTextStore.js';
import { ProjectAccess } from '#src/project/ProjectAccess.js';

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
    const apiStore = fixtureWorkspace(apiRoot);
    const webStore = fixtureWorkspace(webRoot);
    const workspace = new MultiRootWorkspaceTextStore(context, [
      { name: 'api', store: apiStore },
      { name: 'web', store: webStore },
    ]);
    const index = new MultiRootWorkspacePathIndex(context.id, [
      {
        name: 'api',
        index: fixtureIndex({
          binaryPath,
          root: apiRoot,
          cachePath: join(state, 'api.bin'),
          caseSensitive: apiStore.caseSensitive,
        }),
      },
      {
        name: 'web',
        index: fixtureIndex({
          binaryPath,
          root: webRoot,
          cachePath: join(state, 'web.bin'),
          caseSensitive: webStore.caseSensitive,
        }),
      },
    ]);
    const access = new ProjectAccess(
      workspace,
      index,
      {},
      undefined,
      new NativePinnedSourceAuthority(new NativeFilesystemMetadata(binaryPath), new WorkspaceAccessPolicy(), () => {}),
    );

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
      const retain = vi.fn<NonNullable<ToolExecutionContext['retainResultAccess']>>();
      const signal = new AbortController().signal;
      const search = await access.execute(
        'search_project_contents',
        JSON.stringify({
          pattern: 'sharedNeedle',
          pattern_kind: 'literal',
          path: null,
          file_glob: null,
          file_type: null,
          output_mode: 'content',
          lines_before: 0,
          lines_after: 0,
          case_sensitive: true,
          multiline: false,
          limit: 1,
          offset: 1,
        }),
        signal,
        { retainResultAccess: retain },
      );
      expect(JSON.parse(search)).toMatchObject({ matches: [{ path: 'web/src/App.tsx' }] });
      expect(search).not.toContain('sourceIdentity');
      const authorizeSearch = retain.mock.calls[0]![1]!;
      retain.mockClear();
      // Only the returned page contributes text to this provider request.
      await rename(join(apiRoot, 'src'), join(apiRoot, 'retired'));
      (await authorizeSearch(signal))();
      const text = await access.execute(
        'read_project_file',
        JSON.stringify({ path: 'web/src/App.tsx', start_line: null, end_line: null }),
        signal,
        { retainResultAccess: retain },
      );
      expect(text).toContain('sharedNeedle');
      const authorize = retain.mock.calls[0]![1]!;
      await writeFile(join(webRoot, 'saving'), 'A normal atomic save');
      await rename(join(webRoot, 'saving'), join(webRoot, 'src', 'App.tsx'));
      (await authorize(signal))();
      (await authorizeSearch(signal))();
      await rename(join(webRoot, 'src'), join(webRoot, 'old'));
      await mkdir(join(webRoot, 'src'));
      await writeFile(join(webRoot, 'src', 'App.tsx'), 'Same path in another directory');
      await expect(authorize(signal)).rejects.toThrow('source location changed');
      await expect(authorizeSearch(signal)).rejects.toThrow('source location changed');
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
