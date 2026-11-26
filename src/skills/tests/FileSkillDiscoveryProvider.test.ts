import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { FileSkillDiscoveryProvider } from '#src/skills/FileSkillDiscoveryProvider.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';

describe(FileSkillDiscoveryProvider, () => {
  it('discovers a larger catalog with bounded simultaneous metadata reads', async () => {
    const fixture = await skillFixture();
    const paths = Array.from({ length: 19 }, (_, i) => `.glyph/skills/example-${i}/SKILL.md`);
    let active = 0,
      peak = 0;
    vi.spyOn(fixture.store, 'read').mockImplementation(async path => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      const name = path.split('/').at(-2)!;
      return {
        path,
        text: `---\nname: ${name}\ndescription: Example\n---\nBody`,
        revision: 'revision',
        byteOrderMark: false,
        byteLength: 50,
        mode: 0o644,
        identity: path,
      };
    });
    expect(await fixture.provider(paths).discover()).toHaveLength(19);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('keeps valid, missing, and invalid packages visible and snapshots binary resources without expanding them', async () => {
    const fixture = await skillFixture();
    await fixture.write('.glyph/skills/example/SKILL.md', manifest());
    await fixture.write('.glyph/skills/example/references/notes.md', 'REFERENCE');
    await fixture.write('.glyph/skills/example/assets/data.bin', Buffer.from([0, 255]));
    await fixture.write('.glyph/skills/example/assets/nul.bin', Buffer.from([0, 1]));
    await fixture.write('.glyph/skills/missing/resource.md', 'Missing entry');
    await fixture.write('src/.glyph/skills/bad/SKILL.md', 'Bad metadata');
    const paths = [
      '.glyph/skills/example/SKILL.md',
      '.glyph/skills/example/references/notes.md',
      '.glyph/skills/example/assets/data.bin',
      '.glyph/skills/example/assets/nul.bin',
      '.glyph/skills/missing/resource.md',
      'src/.glyph/skills/bad/SKILL.md',
      'unrelated/file.md',
    ];
    const provider = fixture.provider(paths);
    const sources = await provider.discover();
    expect(sources.map(source => [source.name, source.status, source.scope])).toEqual([
      ['example', 'active', '.'],
      ['missing', 'error', '.'],
      ['bad', 'error', 'src'],
    ]);
    expect(JSON.stringify(sources)).not.toContain('BODY');
    const snapshot = await provider.capture(sources[0]!);
    expect(snapshot.body).toBe('BODY');
    expect(snapshot.resources()).toEqual([]);
    await fixture.write('.glyph/skills/example/references/notes.md', 'CHANGED');
    expect(snapshot.readResource('references/notes.md').content).toBe('REFERENCE');
    expect(snapshot.readResource('assets/data.bin')).toMatchObject({ encoding: 'base64', content: 'AP8=' });
    expect(() => snapshot.readResource('../private.md')).toThrow('inside');
    expect(() => snapshot.readResource('missing.md')).toThrow('missing');
    await fixture.write('.glyph/skills/example/SKILL.md', manifest('CHANGED'));
    await expect(provider.capture(sources[0]!)).rejects.toThrow('changed');
    const user = fixture.provider(['.glyph/skills/example/SKILL.md'], 'future-claude');
    const catalog = new SkillCatalog([provider, user]);
    const descriptors = await catalog.refresh();
    expect(descriptors.filter(source => source.name === 'example')).toHaveLength(2);
  });

  it('rejects symlink resources rather than reading outside a package', async () => {
    const fixture = await skillFixture();
    await fixture.write('.glyph/skills/example/SKILL.md', manifest());
    await fixture.write('outside.md', 'OUTSIDE');
    await symlink(join(fixture.root, 'outside.md'), join(fixture.root, '.glyph/skills/example/link.md'));
    const provider = fixture.provider(['.glyph/skills/example/SKILL.md', '.glyph/skills/example/link.md']);
    const [source] = await provider.discover();
    await expect(provider.capture(source!)).rejects.toThrow(/Symbolic|symbolic/u);
  });

  it('keeps other providers discoverable after a provider fails and preserves disabled preferences', async () => {
    const fixture = await skillFixture();
    await fixture.write('.glyph/skills/example/SKILL.md', manifest());
    const provider = fixture.provider(['.glyph/skills/example/SKILL.md']);
    const broken = fixture.provider([], 'broken');
    vi.spyOn(broken, 'discover').mockRejectedValue(new Error('Index unavailable'));
    const enabled = new Map([['project:.glyph/skills/example', false]]);
    const catalog = new SkillCatalog([provider, broken], enabled);
    const change = vi.fn();
    const unsubscribe = catalog.onDidChange(change);
    const sources = await catalog.refresh();
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'example', enabled: false }),
        expect.objectContaining({ status: 'error', message: 'Index unavailable' }),
      ]),
    );
    await catalog.refresh();
    expect(change).toHaveBeenCalledOnce();
    await expect(catalog.capture(sources.find(source => source.name === 'example')!)).rejects.toThrow('disabled');
    unsubscribe();
    await catalog.refreshIndexes();
    expect(fixture.refreshIndex).toHaveBeenCalledTimes(2);
  });

  it('reports truncated discovery and respects cancellation', async () => {
    const fixture = await skillFixture();
    const provider = fixture.provider([]);
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    await expect(provider.discover(controller.signal)).rejects.toThrow('Cancelled');
    const truncated = new FileSkillDiscoveryProvider({
      origin: { id: 'truncated', label: 'Truncated', scope: 'project', compatibility: 'glyph' },
      directory: '.',
      workspace: fixture.store,
      listFiles: async () => ({ files: [], truncated: true }),
      uriForPath: path => path,
      refreshIndex: async () => {},
    });
    await expect(truncated.discover()).rejects.toThrow('incomplete');
    expect(() => new SkillCatalog([provider, provider])).toThrow('unique');
  });
});

async function skillFixture() {
  const root = await mkdtemp(join(tmpdir(), 'glyph-skill-package-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const store = new FileSystemWorkspaceTextStore(root);
  const refreshIndex = vi.fn(async () => {});
  return {
    root,
    store,
    refreshIndex,
    async write(path: string, content: string | Buffer) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    },
    provider(paths: readonly string[], id = 'project') {
      return new FileSkillDiscoveryProvider({
        origin: { id, label: id, scope: 'project', compatibility: id },
        directory: '.glyph/skills',
        workspace: store,
        binaryStore: store,
        listFiles: async () => ({ files: paths, truncated: false }),
        uriForPath: path => pathToFileURL(join(root, path)).href,
        refreshIndex,
      });
    },
  };
}

function manifest(body = 'BODY') {
  return `---\nname: example\ndescription: Use for examples\n---\n${body}`;
}

describe('Skill compatibility location boundaries', () => {
  it.each(['user', 'project'] as const)('supports independent %s layouts and scope prefixes', async scope => {
    const fixture = await skillFixture();
    await fixture.write(
      'example/SKILL.md',
      '---\nname: example\ndescription: Example\ncompatibility: Requires Python\n---\nBody',
    );
    const provider = new FileSkillDiscoveryProvider({
      origin: { id: scope, label: scope, scope, compatibility: 'future' },
      directory: '.',
      scopePrefix: 'root',
      workspace: fixture.store,
      uriForPath: path => path,
      listFiles: async () => ({ files: ['', 'orphan.md', 'example/SKILL.md'], truncated: false }),
      refreshIndex: async () => {},
    });
    expect(await provider.discover()).toEqual([
      expect.objectContaining({ scope: 'root', compatibility: 'Requires Python' }),
    ]);
    const nested = new FileSkillDiscoveryProvider({
      origin: { id: scope, label: scope, scope: 'project', compatibility: 'future' },
      directory: '.glyph/skills',
      scopePrefix: 'root',
      workspace: fixture.store,
      uriForPath: path => path,
      listFiles: async () => ({ files: ['src/.glyph/skills/example/SKILL.md'], truncated: false }),
      refreshIndex: async () => {},
    });
    expect((await nested.discover())[0]?.scope).toBe('root/src');
  });
  it('propagates cancellation during a source read and reports non-Error failures', async () => {
    const fixture = await skillFixture();
    const controller = new AbortController();
    const provider = fixture.provider(['.glyph/skills/example/SKILL.md']);
    vi.spyOn(fixture.store, 'read').mockImplementationOnce(async () => {
      controller.abort(new Error('Cancelled'));
      throw new Error('Read failed');
    });
    await expect(provider.discover(controller.signal)).rejects.toThrow('Cancelled');
    vi.spyOn(fixture.store, 'read').mockRejectedValueOnce('Unavailable');
    expect((await provider.discover())[0]?.message).toBe('Skill metadata is unavailable.');
  });
});
