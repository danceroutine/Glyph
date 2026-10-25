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
  it('discovers Markdown instructions without frontmatter and resolves only the target ancestor chain', async () => {
    const { catalog } = await fixture();
    const context = await catalog.context();

    expect(context.schema).toBe('glyph.agent-instructions.v1');
    expect(context.sources.map(source => [source.path, source.scope, source.content])).toEqual([
      ['AGENTS.md', '.', 'root guidance'],
      ['docs/AGENTS.md', 'docs', 'docs guidance'],
      ['src/AGENTS.md', 'src', 'source guidance'],
    ]);
    expect(catalog.resolve('src/feature/file.ts').map(source => source.path)).toEqual(['AGENTS.md', 'src/AGENTS.md']);
    expect(catalog.resolve('docs/readme.md').map(source => source.path)).toEqual(['AGENTS.md', 'docs/AGENTS.md']);
  });

  it('freezes a turn, discloses only roots up front, and reveals nested scopes once on demand', async () => {
    const { root, catalog } = await fixture();

    await expect(catalog.beginTurn('turn-1', [])).resolves.toMatchObject({
      sources: [{ path: 'AGENTS.md', scope: '.' }],
    });
    expect(catalog.disclose('turn-1', ['src/feature/file.ts'])?.sources.map(source => source.path)).toEqual([
      'src/AGENTS.md',
    ]);
    expect(catalog.disclose('turn-1', ['src/other.ts'])).toBeUndefined();
    expect(catalog.disclose('turn-1', ['docs/readme.md'])?.sources.map(source => source.path)).toEqual([
      'docs/AGENTS.md',
    ]);
    expect(catalog.disclose('unknown-turn', ['src/file.ts'])).toBeUndefined();

    await writeFile(join(root, 'src', 'AGENTS.md'), 'later revision');
    expect(catalog.resolve('src/file.ts').at(-1)?.content).toBe('source guidance');
    await catalog.beginTurn('turn-2', []);
    expect(catalog.disclose('turn-2', ['src/file.ts'])?.sources.at(-1)?.content).toBe('later revision');
  });

  it('includes the scoped chain for attached files in initial turn context', async () => {
    const { catalog } = await fixture();
    const context = await catalog.beginTurn('attached', ['src/feature/file.ts']);
    expect(context.sources.map(source => source.path)).toEqual(['AGENTS.md', 'src/AGENTS.md']);
    expect(catalog.disclose('attached', ['src/other.ts'])).toBeUndefined();
  });

  it('bounds frozen turn snapshots and evicts the oldest turn', async () => {
    const { catalog } = await fixture();
    for (let index = 0; index < 33; index++) await catalog.beginTurn(`turn-${index}`, []);

    expect(catalog.disclose('turn-0', ['src/file.ts'])).toBeUndefined();
    expect(catalog.disclose('turn-32', ['src/file.ts'])?.sources.map(source => source.path)).toEqual(['src/AGENTS.md']);
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
