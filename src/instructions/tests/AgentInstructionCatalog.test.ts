import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import { AgentsMdInstructionProvider } from '#src/instructions/AgentsMdInstructionProvider.js';
import {
  AgentInstructionSourceKind,
  AgentInstructionSourceStatus,
  type AgentInstructionSource,
} from '#src/instructions/AgentInstructionSource.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glyph-instructions-'));
  roots.push(root);
  await Promise.all([mkdir(join(root, 'src', 'feature'), { recursive: true }), mkdir(join(root, 'docs'))]);
  await writeFile(join(root, 'AGENTS.md'), 'root guidance');
  await writeFile(join(root, 'src', 'AGENTS.md'), 'source guidance');
  await writeFile(join(root, 'docs', 'AGENTS.md'), 'docs guidance');
  const catalog = new AgentInstructionCatalog([
    new AgentsMdInstructionProvider(new FileSystemWorkspaceTextStore(root)),
  ]);
  return { root, catalog };
}

describe(AgentInstructionCatalog, () => {
  it('places ancestor instructions before nearer rules regardless of source family', async () => {
    const root = instructionSource('AGENTS.md', '.');
    const nested = {
      ...instructionSource('src/.glyph/rules/typescript.mdc', 'src'),
      kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
    };
    const catalog = new AgentInstructionCatalog([{ discover: async () => [nested, root] }]);

    expect(await catalog.refresh()).toEqual([root, nested]);
    expect(catalog.resolve('src/app.ts')).toEqual([root, nested]);
    // A caller can resolve a retained snapshot independently of the current catalog.
    expect(catalog.resolve('src/app.ts', [root])).toEqual([root]);
  });

  it('discovers Markdown instructions without frontmatter and resolves only the target ancestor chain', async () => {
    const { catalog } = await fixture();
    const sources = await catalog.refresh();
    expect(sources.map(source => [source.path, source.scope, source.content])).toEqual([
      ['AGENTS.md', '.', 'root guidance'],
      ['docs/AGENTS.md', 'docs', 'docs guidance'],
      ['src/AGENTS.md', 'src', 'source guidance'],
    ]);
    expect(catalog.resolve('src/feature/file.ts').map(source => source.path)).toEqual(['AGENTS.md', 'src/AGENTS.md']);
    expect(catalog.resolve('docs/readme.md').map(source => source.path)).toEqual(['AGENTS.md', 'docs/AGENTS.md']);
  });

  it('refreshes created, edited, and deleted instruction files and emits only changed snapshots', async () => {
    const { root, catalog } = await fixture();
    const changed = vi.fn();
    const unsubscribe = catalog.onDidChange(changed);
    await catalog.refresh();
    await catalog.refresh();
    expect(changed).toHaveBeenCalledTimes(1);

    await writeFile(join(root, 'src', 'AGENTS.md'), 'updated guidance');
    await catalog.refresh();
    expect(catalog.resolve('src/file.ts').at(-1)?.content).toBe('updated guidance');

    await rm(join(root, 'docs', 'AGENTS.md'));
    await catalog.refresh();
    expect(catalog.sources.map(source => source.path)).not.toContain('docs/AGENTS.md');
    expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe();
    await writeFile(join(root, 'AGENTS.md'), 'after unsubscribe');
    await catalog.refresh();
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('reports oversized files by path and omits symlinked instruction files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyph-instructions-'));
    roots.push(root);
    await mkdir(join(root, 'linked'));
    await writeFile(join(root, 'AGENTS.md'), 'too large');
    await writeFile(join(root, 'outside.md'), 'outside');
    await symlink(join(root, 'outside.md'), join(root, 'linked', 'AGENTS.md'));
    const catalog = new AgentInstructionCatalog([
      new AgentsMdInstructionProvider(new FileSystemWorkspaceTextStore(root), { maxBytes: 3 }),
    ]);

    expect((await catalog.refresh()).map(source => source.path)).toEqual(['AGENTS.md']);
    expect(catalog.sources[0]).toMatchObject({
      status: AgentInstructionSourceStatus.ERROR,
      message: 'File exceeds the 3-byte read limit.',
    });
    expect(catalog.resolve('file.ts')).toEqual([]);
  });

  it('reports discovery truncation and preserves provider ordering', async () => {
    const active = instructionSource('src/AGENTS.md', 'src');
    const workspace = {
      list: vi.fn().mockResolvedValue({ files: [active.path], truncated: true }),
      normalizePath: vi.fn((path: string) => path),
      read: vi.fn().mockResolvedValue({ text: 'rules', revision: 'one' }),
    } as unknown as WorkspaceTextStore;
    const provider = new AgentsMdInstructionProvider(workspace, { maxFiles: 1 });

    expect(await provider.discover()).toEqual([
      expect.objectContaining({ path: 'AGENTS.md', status: AgentInstructionSourceStatus.ERROR }),
      expect.objectContaining({ path: 'src/AGENTS.md', status: AgentInstructionSourceStatus.ACTIVE }),
    ]);
  });

  it('reports the default discovery limit when no override is configured', async () => {
    const provider = new AgentsMdInstructionProvider({} as WorkspaceTextStore, {}, async () => ({
      files: [],
      truncated: true,
    }));
    await expect(provider.discover()).resolves.toEqual([
      expect.objectContaining({ message: 'Instruction discovery exceeded the 10000-file limit.' }),
    ]);
  });

  it('reports a workspace discovery failure instead of silently dropping mandatory guidance', async () => {
    const workspace = {
      list: vi.fn().mockRejectedValue(new Error('Index is unavailable.')),
    } as unknown as WorkspaceTextStore;
    const provider = new AgentsMdInstructionProvider(workspace);

    await expect(provider.discover()).resolves.toEqual([
      expect.objectContaining({
        path: 'AGENTS.md',
        status: AgentInstructionSourceStatus.ERROR,
        message: 'Index is unavailable.',
      }),
    ]);
  });

  it('uses fallback messages for non-Error discovery and read failures', async () => {
    const discovery = new AgentsMdInstructionProvider({} as WorkspaceTextStore, {}, async () => {
      throw 'untyped discovery failure';
    });
    await expect(discovery.discover()).resolves.toEqual([
      expect.objectContaining({ message: 'Instruction files could not be discovered.' }),
    ]);

    const workspace = {
      normalizePath: (path: string) => path,
      read: vi.fn().mockRejectedValue('untyped read failure'),
    } as unknown as WorkspaceTextStore;
    const read = new AgentsMdInstructionProvider(workspace, {}, async () => ({
      files: ['AGENTS.md'],
      truncated: false,
    }));
    await expect(read.discover()).resolves.toEqual([
      expect.objectContaining({ message: 'Instruction file could not be read.' }),
    ]);
  });

  it.each(['discovery', 'read'] as const)('propagates cancellation during %s', async phase => {
    const controller = new AbortController();
    const cancelled = new Error('Cancelled');
    const workspace = {
      normalizePath: (path: string) => path,
      read: vi.fn(async () => {
        controller.abort(cancelled);
        throw new Error('read stopped');
      }),
    } as unknown as WorkspaceTextStore;
    const provider = new AgentsMdInstructionProvider(workspace, {}, async () => {
      if (phase === 'discovery') {
        controller.abort(cancelled);
        throw new Error('listing stopped');
      }
      return { files: ['AGENTS.md'], truncated: false };
    });

    await expect(provider.discover(controller.signal)).rejects.toBe(cancelled);
  });

  it('orders source families and suppresses a Cursor rule shadowed by a native rule', async () => {
    const source = (kind: AgentInstructionSourceKind, path: string, name?: string): AgentInstructionSource => ({
      id: `${kind}:${path}`,
      kind,
      label: kind,
      path,
      scope: '.',
      status: AgentInstructionSourceStatus.ACTIVE,
      ...(name ? { name } : {}),
    });
    const catalog = new AgentInstructionCatalog([
      {
        discover: async () => [
          source(AgentInstructionSourceKind.AGENTS_MD, 'AGENTS.md'),
          source(AgentInstructionSourceKind.GLYPH_PROJECT_RULE, '.glyph/rules/shared.mdc', 'Shared'),
          source(AgentInstructionSourceKind.GLYPH_PROJECT_RULE, '.glyph/rules/native.mdc'),
          source(AgentInstructionSourceKind.CURSOR_PROJECT_RULE, '.cursor/rules/shared.mdc', 'Shared'),
          source(AgentInstructionSourceKind.CURSOR_PROJECT_RULE, '.cursor/rules/cursor.mdc'),
          source(AgentInstructionSourceKind.GLYPH_USER_RULE, '~/.glyph/rules/user.mdc'),
        ],
      },
    ]);

    expect((await catalog.refresh()).map(value => value.kind)).toEqual([
      AgentInstructionSourceKind.GLYPH_USER_RULE,
      AgentInstructionSourceKind.CURSOR_PROJECT_RULE,
      AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      AgentInstructionSourceKind.GLYPH_PROJECT_RULE,
      AgentInstructionSourceKind.AGENTS_MD,
    ]);
    expect(catalog.sources.map(value => value.path)).not.toContain('.cursor/rules/shared.mdc');
  });
});

function instructionSource(path: string, scope: string): AgentInstructionSource {
  return {
    id: `${AgentInstructionSourceKind.AGENTS_MD}:${path}`,
    kind: AgentInstructionSourceKind.AGENTS_MD,
    label: 'AGENTS.md',
    path,
    scope,
    status: AgentInstructionSourceStatus.ACTIVE,
    content: 'rules',
  };
}
