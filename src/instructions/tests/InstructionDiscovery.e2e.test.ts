import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { AgentInstructionCatalog } from '#src/instructions/AgentInstructionCatalog.js';
import { AgentInstructionSourceKind, AgentInstructionSourceStatus } from '#src/instructions/AgentInstructionSource.js';
import { AgentsMdInstructionProvider } from '#src/instructions/AgentsMdInstructionProvider.js';
import { listInstructionFilesAcrossRoots } from '#src/instructions/listInstructionFilesAcrossRoots.js';
import { AgentRuleInstructionProvider } from '#src/instructions/rules/AgentRuleInstructionProvider.js';
import { listUserRuleFiles } from '#src/instructions/rules/listUserRuleFiles.js';
import { UserAgentRuleManager } from '#src/instructions/rules/UserAgentRuleManager.js';

describe('Native instruction discovery', () => {
  it('indexes only the user rules directory and publishes managed changes before returning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'glyph-user-rules-index-'));
    const rulesRoot = join(root, 'rules');
    await mkdir(join(rulesRoot, 'nested'), { recursive: true });
    const workspace = new FileSystemWorkspaceTextStore(root);
    const index = new RustWorkspacePathIndex({
      root: rulesRoot,
      binaryPath: resolve(
        'target',
        'release',
        process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
      ),
      respectGitIgnore: false,
    });
    onTestFinished(async () => {
      await index.dispose();
      await rm(root, { recursive: true, force: true });
    });
    const diskList = vi.spyOn(workspace, 'list').mockRejectedValue(new Error('No filesystem listing fallback.'));
    await writeFile(join(root, 'outside.mdc'), 'Not a rule');
    await writeFile(join(root, 'reference.md'), 'Referenced guidance');
    await writeFile(join(rulesRoot, 'nested/hidden.mdc'), 'Nested files are not user rules');
    await writeFile(join(rulesRoot, 'existing.mdc'), '---\nreferences: [reference.md]\n---\nExisting guidance');
    await writeFile(join(rulesRoot, '.gitignore'), '*.mdc\n');
    await symlink(join(root, 'outside.mdc'), join(rulesRoot, 'link.mdc'));
    const catalog = new AgentInstructionCatalog([
      new AgentRuleInstructionProvider(
        workspace,
        {
          kind: AgentInstructionSourceKind.GLYPH_USER_RULE,
          directory: '.',
          displayPrefix: '~/.glyph/',
        },
        maxFiles => listUserRuleFiles(index, maxFiles),
      ),
    ]);
    await expect(catalog.refresh()).resolves.toEqual([
      expect.objectContaining({
        path: '~/.glyph/rules/existing.mdc',
        content: expect.stringContaining('Referenced guidance'),
      }),
    ]);
    await expect(index.glob('outside.mdc', { limit: 10 })).resolves.toEqual({ files: [], truncated: false });
    const refresh = vi.spyOn(index, 'refresh');
    const manager = new UserAgentRuleManager(workspace, catalog, index);
    await manager.create('Style', 'manual');
    expect(catalog.sources.map(source => source.path)).toContain('~/.glyph/rules/style.mdc');
    const created = await workspace.read('rules/style.mdc');
    await manager.setEnabled('rules/style.mdc', created.revision, false);
    expect(catalog.sources.find(source => source.path === '~/.glyph/rules/style.mdc')?.enabled).toBe(false);
    const disabled = await workspace.read('rules/style.mdc');
    await manager.remove('rules/style.mdc', disabled.revision);
    expect(catalog.sources.map(source => source.path)).toEqual(['~/.glyph/rules/existing.mdc']);
    expect(refresh).toHaveBeenCalledTimes(3);
    await catalog.refresh();
    expect(refresh).toHaveBeenCalledTimes(3);
    await writeFile(join(rulesRoot, 'external.mdc'), 'External guidance');
    await expect
      .poll(async () => (await catalog.refresh()).map(source => source.path), { timeout: 10_000 })
      .toContain('~/.glyph/rules/external.mdc');
    await rm(join(rulesRoot, 'external.mdc'));
    await expect
      .poll(async () => (await catalog.refresh()).map(source => source.path), { timeout: 10_000 })
      .toEqual(['~/.glyph/rules/existing.mdc']);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(diskList).not.toHaveBeenCalled();
  });

  it('discovers root and nested instruction families through the shared index and enforces its exclusions', async () => {
    const fixture = await instructionFixture();
    const included = [
      'AGENTS.md',
      'src/AGENTS.md',
      '.glyph/rules/root.mdc',
      'src/.glyph/rules/nested.mdc',
      '.cursor/rules/compat.mdc',
      'src/.cursor/rules/nested-compat.mdc',
    ];
    const excluded = [
      'node_modules/AGENTS.md',
      'private/AGENTS.md',
      'ignored/AGENTS.md',
      'ignored/.glyph/rules/style.mdc',
      'private/.cursor/rules/style.mdc',
      '.glyph/rules/deeper/not-a-rule.mdc',
    ];
    await mkdir(join(fixture.root, '.git'));
    await fixture.write('.gitignore', 'ignored/\n');
    for (const path of [...included, ...excluded]) await fixture.write(path, `Guidance for ${path}`);
    await symlink(join(fixture.root, 'src'), join(fixture.root, 'linked'), 'dir');
    await symlink(join(fixture.root, '.glyph/rules/root.mdc'), join(fixture.root, '.glyph/rules/link.mdc'));

    const sources = await fixture.catalog.refresh();
    expect(sources.map(source => source.path).toSorted()).toEqual(included.toSorted());
    expect(sources.every(source => source.status === AgentInstructionSourceStatus.ACTIVE)).toBe(true);
    expect(fixture.catalog.resolve('src/example.ts').map(source => source.scope)).toEqual([
      '.',
      '.',
      '.',
      'src',
      'src',
      'src',
    ]);
    await expect(fixture.list(1, '**/AGENTS.md')).resolves.toEqual({ files: ['AGENTS.md'], truncated: true });
    expect(fixture.diskList).not.toHaveBeenCalled();
  });

  it('observes file creation, edits, and deletion on later catalog refreshes without rescanning in TypeScript', async () => {
    const fixture = await instructionFixture();
    await fixture.write('AGENTS.md', 'Initial guidance');
    await fixture.catalog.refresh();
    const refreshIndex = vi.spyOn(fixture.index, 'refresh');
    await fixture.write('AGENTS.md', 'Updated guidance');
    await expect(fixture.catalog.refresh()).resolves.toEqual([
      expect.objectContaining({ path: 'AGENTS.md', content: 'Updated guidance' }),
    ]);

    await fixture.write('new/.glyph/rules/style.mdc', 'New guidance');
    await expect
      .poll(async () => (await fixture.catalog.refresh()).map(source => source.path), { timeout: 10_000 })
      .toContain('new/.glyph/rules/style.mdc');
    await rm(join(fixture.root, 'new'), { recursive: true });
    await expect
      .poll(async () => (await fixture.catalog.refresh()).map(source => source.path), { timeout: 10_000 })
      .toEqual(['AGENTS.md']);
    expect(refreshIndex).not.toHaveBeenCalled();
    expect(fixture.diskList).not.toHaveBeenCalled();
  });
});

async function instructionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'glyph-instruction-index-'));
  const excludedPaths = ['private'];
  const workspace = new FileSystemWorkspaceTextStore(root, { excludedPaths });
  const index = new RustWorkspacePathIndex({
    root,
    excludedPaths,
    binaryPath: resolve(
      'target',
      'release',
      process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
    ),
  });
  const diskList = vi
    .spyOn(workspace, 'list')
    .mockRejectedValue(new Error('Instruction discovery must use the index.'));
  onTestFinished(async () => {
    await index.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const list = (maxFiles: number, globPattern: string) =>
    listInstructionFilesAcrossRoots([{ name: 'workspace', index }], maxFiles, globPattern);
  const catalog = new AgentInstructionCatalog([
    new AgentsMdInstructionProvider(workspace, {}, list),
    new AgentRuleInstructionProvider(
      workspace,
      { kind: AgentInstructionSourceKind.GLYPH_PROJECT_RULE, directory: '.glyph' },
      list,
    ),
    new AgentRuleInstructionProvider(
      workspace,
      { kind: AgentInstructionSourceKind.CURSOR_PROJECT_RULE, directory: '.cursor' },
      list,
    ),
  ]);
  return {
    root,
    index,
    catalog,
    list,
    diskList,
    async write(path: string, text: string) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    },
  };
}
