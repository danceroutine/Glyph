import { InstructionPaths } from '#src/instructions/InstructionPaths.js';
import { WorkspaceSourceRoutes } from '#src/workspace/WorkspaceSourceRoutes.js';
import { WorkspaceReadFailure } from '#src/workspace/WorkspaceReadFailure.js';
import type { PinnedSourceAuthority } from '#src/workspace/PinnedSourceAuthority.js';
import { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import { mkdtemp, mkdir, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceReadLimitError } from '#src/workspace/WorkspaceReadLimitError.js';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { fixtureWorkspace } from '#src/workspace/tests/fixtures/workspaceAccess.js';
import { FileSkillDiscoveryProvider } from '#src/skills/FileSkillDiscoveryProvider.js';
import { SkillContextContributor } from '#src/skills/SkillContextContributor.js';
import { SkillToolRuntime } from '#src/skills/SkillToolRuntime.js';
import { chatTurnOptionsSchema } from '#src/chat/ChatTurnOptionsSchema.js';
import { packageRevision, fileRevision } from '#src/skills/skillPackageRevision.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';

it('retains missing manifest diagnostics and the stored path of a physically classified package', async () => {
  const fixture = await skillFixture();
  const stored = 'nested/.glyph/ſkills/example/ſKILL.md';
  await fixture.write(stored, manifest());
  const provider = new FileSkillDiscoveryProvider({
    origin: { id: 'project', label: 'Project', scope: 'project', compatibility: 'glyph' },
    directory: '.glyph/skills',
    workspace: fixture.store,
    scopePrefix: 'repo',
    listPackages: async () => ({
      truncated: false,
      packages: [
        { directory: 'nested/.glyph/ſkills/example', manifest: stored },
        { directory: 'nested/.glyph/ſkills/missing', manifest: null },
      ],
    }),
    captureFiles: async () => ({ files: [stored], truncated: false }),
    uriForPath: path => path,
    refreshIndex: async () => {},
  });
  expect(await provider.discover()).toMatchObject([
    { path: stored, scope: 'repo/nested', status: 'active' },
    { path: 'nested/.glyph/ſkills/missing/SKILL.md', scope: 'repo/nested', status: 'error' },
  ]);
});

describe(FileSkillDiscoveryProvider, () => {
  it('discloses pinned resource bytes only while the manifest and selected file remain authorized', async () => {
    const fixture = await skillFixture();
    const manifestPath = '.glyph/skills/example/SKILL.md';
    const resourcePath = '.glyph/skills/example/guide.txt';
    await fixture.write(manifestPath, manifest());
    await fixture.write(resourcePath, 'frozen resource');
    const denied = new Set<string>();
    let mismatch = false;
    const authority: PinnedSourceAuthority = {
      capture: async paths =>
        Promise.all(
          paths.map(async path => {
            const file = await stat(path);
            return { path, identity: mismatch ? 'replacement' : file.dev + ':' + file.ino, origin: path };
          }),
        ),
      authorize: async pins => () => {
        if (pins.some(pin => denied.has(pin.path))) throw new Error('Read denied');
      },
    };
    const provider = fixture.provider([manifestPath, resourcePath], 'project', authority);
    const catalog = new SkillCatalog([provider]);
    const turns = new TurnContextCoordinator([new SkillContextContributor(catalog)]);
    const session = await turns.beginTurn({ turnId: 'turn', attachmentPaths: [] });
    const id = session.initialEnvelope().skillCandidates![0]!.id;
    denied.add(join(fixture.root, manifestPath));
    await expect(turns.activateSource('turn', 'skills', id, 'model', 'use it')).rejects.toThrow('Read denied');
    expect(session.snapshot().skills).toBeUndefined();
    denied.clear();
    mismatch = true;
    await expect(turns.activateSource('turn', 'skills', id, 'model', 'use it')).rejects.toThrow(
      'changed during capture',
    );
    mismatch = false;
    await turns.activateSource('turn', 'skills', id, 'model', 'use it');
    const tool = new SkillToolRuntime(turns).tools[1]!;
    const read = () =>
      tool.execute(JSON.stringify({ id, path: 'guide.txt' }), new AbortController().signal, { turnId: 'turn' });
    denied.add(join(fixture.root, resourcePath));
    const guard = await turns.authorizeDisclosure('turn');
    guard();
    await expect(read()).rejects.toThrow('Read denied');
    expect(session.snapshot().skills![0]!.resources).toEqual([]);
    denied.clear();
    await fixture.write(resourcePath, 'new revision');
    expect(await read()).toContain('frozen resource');
    denied.add(join(fixture.root, resourcePath));
    await expect(turns.authorizeDisclosure('turn')).rejects.toThrow('Read denied');
  });

  it('leaves historical IDs unresolved when a location provides no legacy identity scheme', async () => {
    const fixture = await skillFixture();
    const provider = fixture.provider([]);
    expect(provider.matchesLegacyId('.glyph/skills/example', 'previous', { remaining: 1 })).toBe(false);
  });
  it('uses user scope for indexed packages and keeps the most specific route when providers overlap', async () => {
    const fixture = await skillFixture();
    const manifestPath = 'skills/example/SKILL.md';
    await fixture.write(manifestPath, manifest());
    const provider = (id: string, directory: string) =>
      new FileSkillDiscoveryProvider({
        origin: { id, label: id, scope: 'user', compatibility: 'glyph' },
        directory: 'skills',
        workspace: fixture.store,
        packageId: () => 'same',
        listPackages: async () => ({ truncated: false, packages: [{ directory, manifest: manifestPath }] }),
        captureFiles: async () => ({ truncated: false, files: [] }),
        uriForPath: path => pathToFileURL(join(fixture.root, path)).href,
        refreshIndex: async () => {},
      });
    const refresh = vi.fn();
    const catalog = new SkillCatalog(
      [
        provider('long', 'prefix/skills/example'),
        provider('owner', 'skills/example'),
        provider('alias', 'root/skills/example'),
      ],
      undefined,
      undefined,
      refresh,
    );
    expect(await catalog.refresh()).toMatchObject([{ id: 'same', scope: '.', origin: { id: 'owner' } }]);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('charges actual bytes for rejected reads and retains later valid manifests', async () => {
    const fixture = await skillFixture();
    const names = Array.from({ length: 32 }, (_, i) => 'bad-' + String(i).padStart(2, '0'));
    const paths = names.map(name => '.glyph/skills/' + name + '/SKILL.md');
    await Promise.all(paths.map((path, i) => fixture.write(path, Buffer.from([i % 2 === 0 ? 255 : 0]))));
    const good = '.glyph/skills/example/SKILL.md';
    await fixture.write(good, manifest());
    const missing = '.glyph/skills/absent/SKILL.md';
    const read = fixture.store.read.bind(fixture.store);
    vi.spyOn(fixture.store, 'read').mockImplementation((path, options) => {
      if (path === missing) return Promise.reject(new WorkspaceReadLimitError(path, 10, 11, 11));
      return read(path, options);
    });
    const found = await fixture.provider([...paths, missing, '.glyph/skills/deleted/SKILL.md', good]).discover();
    expect(found.filter(skill => skill.status === 'active').map(skill => skill.name)).toEqual(['example']);
    expect(found.filter(skill => skill.message?.includes('8 MiB'))).toEqual([]);
  });
  it('charges both completed disk reads when editor snapshot validation rejects a skill manifest', async () => {
    const fixture = await skillFixture();
    const paths = Array.from({ length: 17 }, (_, i) => '.glyph/skills/p-' + i + '/SKILL.md');
    const read = vi
      .spyOn(fixture.store, 'read')
      .mockRejectedValue(new WorkspaceReadFailure(new Error('Editor conflict'), 512 * 1024));
    const sources = await fixture.provider(paths).discover();
    expect(read).toHaveBeenCalledTimes(16);
    expect(sources.filter(source => source.message?.includes('8 MiB'))).toHaveLength(1);
  });
  it('folds single-root scope keys independently of the platform running the tests', async () => {
    const fixture = await skillFixture();
    const provider = new FileSkillDiscoveryProvider({
      origin: { id: 'a', label: 'a', scope: 'project', compatibility: 'glyph' },
      directory: '.glyph/skills',
      workspace: fixtureWorkspace(fixture.root, { caseSensitive: false }),
      listFiles: async () => ({ files: [], truncated: false }),
      uriForPath: path => path,
      refreshIndex: async () => {},
    });
    expect(provider.scopePathKey('Src/Index')).toBe('src/index');
  });
  it('uses the owning volume’s filename policy for nested skill advertisements', async () => {
    const fixture = await skillFixture();
    const composed = 'café',
      decomposed = composed.normalize('NFD');
    const manifestPath = composed + '/.glyph/skills/example/SKILL.md';
    await fixture.write(manifestPath, manifest());
    const sameDirectoryEntry = await fixture.store.exists(decomposed + '/.glyph/skills/example/SKILL.md');
    for (const normalizesUnicode of [false, true]) {
      const sharesScope = normalizesUnicode && sameDirectoryEntry;
      const prepare = vi.fn();
      const routes = Object.assign(
        new WorkspaceSourceRoutes([{ name: 'project', path: fixture.root, normalizesUnicode }]),
        { prepare },
      );
      const paths = new InstructionPaths(fixture.store.caseSensitive, routes);
      const provider = new FileSkillDiscoveryProvider({
        origin: { id: 'project', label: 'Project', scope: 'project', compatibility: 'glyph' },
        directory: '.glyph/skills',
        scopePathKey: paths.key.bind(paths),
        workspace: fixture.store,
        listFiles: async () => ({ files: [manifestPath], truncated: false }),
        uriForPath: path => path,
        refreshIndex: fixture.refreshIndex,
      });
      const catalog = new SkillCatalog([provider], undefined, undefined, undefined, undefined, undefined, routes);
      const turn = await new SkillContextContributor(catalog).beginTurn({ turnId: 't', attachmentPaths: [] });
      const attachments = [decomposed + '/file', decomposed + '/new'];
      expect(turn.disclosePaths(attachments)?.skillCandidates?.length).toBe(sharesScope ? 1 : undefined);
      expect(prepare).toHaveBeenLastCalledWith([...attachments, composed]);
      expect(turn.disclosePaths([composed + '/file'])?.skillCandidates?.length).toBe(sharesScope ? undefined : 1);
    }
  });
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
    expect((await snapshot.readResource('references/notes.md')).content).toBe('REFERENCE');
    expect(await snapshot.readResource('assets/data.bin')).toMatchObject({ encoding: 'base64', content: 'AP8=' });
    await expect(snapshot.readResource('../private.md')).rejects.toThrow('inside');
    await expect(snapshot.readResource('missing.md')).rejects.toThrow('missing');
    await fixture.write('.glyph/skills/example/SKILL.md', manifest('CHANGED'));
    await expect(provider.capture(sources[0]!)).rejects.toThrow('changed');
    const user = fixture.provider(['.glyph/skills/example/SKILL.md'], 'future-claude');
    const catalog = new SkillCatalog([provider, user]);
    const descriptors = await catalog.refresh();
    expect(descriptors.filter(source => source.name === 'example')).toHaveLength(2);
  });

  it('offers Edit only for indexed, readable manifests, including a manifest with invalid frontmatter', async () => {
    const fixture = await skillFixture();
    await fixture.write('.glyph/skills/ignored/SKILL.md', manifest());
    await fixture.write('.glyph/skills/ignored/data.txt', 'ordinary resource');
    await fixture.write('.glyph/skills/bad/SKILL.md', 'Missing frontmatter');
    await fixture.write('.glyph/skills/linked/data.txt', 'ordinary resource');
    await fixture.write('outside.md', manifest());
    await symlink(join(fixture.root, 'outside.md'), join(fixture.root, '.glyph/skills/linked/SKILL.md'));
    const read = vi.spyOn(fixture.store, 'read');
    const results = await fixture
      .provider(['.glyph/skills/ignored/data.txt', '.glyph/skills/bad/SKILL.md', '.glyph/skills/linked/SKILL.md'])
      .discover();
    expect(results.map(({ name, status, uri }) => [name, status, !!uri])).toEqual([
      ['bad', 'error', true],
      ['ignored', 'error', false],
      ['linked', 'error', false],
    ]);
    expect(read.mock.calls.map(([path]) => path)).not.toContain('.glyph/skills/ignored/SKILL.md');
  });

  it.each([true, false])(
    'uses owning store casing for discovery and qualified activation scope (caseSensitive=%s)',
    async caseSensitive => {
      const fixture = await skillFixture();
      const path = 'Src/.GLYPH/Skills/example/skill.MD';
      await fixture.write(path, manifest());
      const exact = 'Exact/.glyph/skills/example/SKILL.md';
      await fixture.write(exact, manifest());
      const workspace = fixtureWorkspace(fixture.root, { caseSensitive });
      const provider = new FileSkillDiscoveryProvider({
        origin: { id: 'one', label: 'One', scope: 'project', compatibility: 'glyph' },
        directory: '.glyph/skills',
        scopePrefix: 'Root',
        workspace,
        binaryStore: workspace,
        listFiles: async () => ({ files: [path, exact], truncated: false }),
        uriForPath: listed => listed,
        refreshIndex: async () => {},
      });
      const catalog = new SkillCatalog([provider]);
      const sources = await catalog.refresh();
      if (caseSensitive) {
        expect(sources.map(source => source.scope)).toEqual(['Root/Exact']);
        const turn = await new SkillContextContributor(catalog).beginTurn({
          turnId: 'strict',
          attachmentPaths: ['Root/exact/task'],
        });
        expect(turn.initialEnvelope().skillCandidates).toEqual([]);
        expect(turn.disclosePaths(['Root/Exact/task'])?.skillCandidates?.[0]?.id).toBe(sources[0]!.id);
        return;
      }
      const nested = sources.find(source => source.path === path)!;
      expect(nested).toMatchObject({ status: 'active', scope: 'Root/Src', path });
      const contributor = new SkillContextContributor(catalog);
      const turn = await contributor.beginTurn({ turnId: 'case', attachmentPaths: ['root/src/file'] });
      expect(turn.initialEnvelope().skillCandidates).toEqual([]);
      expect(turn.disclosePaths(['Root/sRc/file'])?.skillCandidates?.[0]?.id).toBe(nested.id);
      expect((await turn.activateSource(nested.id, 'model', 'Task'))?.skills?.[0]?.body).toBe('BODY');
      const initial = await contributor.beginTurn({ turnId: 'case2', attachmentPaths: ['Root/sRC'] });
      expect(initial.initialEnvelope().skillCandidates).toHaveLength(1);
    },
  );

  it('preserves short IDs and offers a stable bounded ID for deep packages on both selection routes', async () => {
    const fixture = await skillFixture();
    const path = `${'long-component/'.repeat(40)}.glyph/skills/example/SKILL.md`;
    await fixture.write(path, manifest());
    const provider = fixture.provider([path]);
    const catalog = new SkillCatalog([provider]);
    const [source] = await catalog.refresh();
    const id = source!.id;
    expect(id.length).toBeLessThanOrEqual(500);
    expect((await catalog.refresh())[0]!.id).toBe(id);
    const options = chatTurnOptionsSchema.parse({ skillIds: [id] });
    const manual = await new SkillContextContributor(catalog).beginTurn({
      turnId: 'long',
      attachmentPaths: [],
      ...options,
    });
    expect(manual.initialEnvelope().skills?.[0]?.body).toBe('BODY');
    const model = await new SkillContextContributor(catalog).beginTurn({ turnId: 'model', attachmentPaths: [path] });
    const runtime = new SkillToolRuntime({
      activateSource: (_turnId, _contributor, sourceId, reason, explanation, signal) =>
        model.activateSource(sourceId, reason, explanation, signal),
      contribution: () => model,
    });
    const input = JSON.stringify({ id, reason: 'Task' });
    runtime.tools[0]!.validateInput(input);
    expect(
      JSON.parse(await runtime.tools[0]!.execute(input, new AbortController().signal, { turnId: 'model' })),
    ).toMatchObject({ activated: true });
  });

  it('uses disk permissions with editor-backed text and fingerprints only permission bits', async () => {
    const fixture = await skillFixture();
    const path = '.glyph/skills/example/SKILL.md';
    await fixture.write(path, manifest());
    const disk = await fixture.store.readBytes(path);
    expect(fileRevision(disk.bytes)).toBe(disk.revision);
    const provider = fixture.provider([path]);
    const [source] = await provider.discover();
    vi.spyOn(fixture.store, 'readBytes').mockResolvedValue({ ...disk, mode: 0o100755 });
    const editor = await fixture.store.read(path);
    vi.spyOn(fixture.store, 'read').mockResolvedValue({ ...editor, mode: 0o644 });
    const pinned = await provider.capture(source!);
    expect(pinned.revision).toBe(packageRevision(new Map([['SKILL.md', { revision: disk.revision, mode: 0o755 }]])));
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
        expect.objectContaining({ status: 'discovery-error', origin: broken.origin, message: 'Index unavailable' }),
      ]),
    );
    await catalog.refresh();
    expect(change).toHaveBeenCalledOnce();
    await expect(catalog.capture(sources.find(source => source.name === 'example')!)).rejects.toThrow('disabled');
    unsubscribe();
    await catalog.refreshIndexes();
    expect(fixture.refreshIndex).toHaveBeenCalledTimes(2);
  });

  it('uses a current package-scoped index at activation and rejects an incomplete capture', async () => {
    const fixture = await skillFixture();
    const manifestPath = '.glyph/skills/example/SKILL.md';
    await fixture.write(manifestPath, manifest());
    const captureFiles = vi.fn(async () => ({ files: [manifestPath], truncated: false }));
    const provider = new FileSkillDiscoveryProvider({
      origin: { id: 'project', label: 'Project', scope: 'project', compatibility: 'glyph' },
      directory: '.glyph/skills',
      workspace: fixture.store,
      uriForPath: path => path,
      listFiles: async () => ({ files: ['.glyph', manifestPath], truncated: false }),
      captureFiles,
      refreshIndex: async () => {},
    });
    const [source] = await provider.discover();
    expect((await provider.capture(source!)).body).toBe('BODY');
    expect(captureFiles).toHaveBeenCalledWith(source!.directory, undefined);
    captureFiles.mockResolvedValueOnce({ files: [], truncated: true });
    await expect(provider.capture(source!)).rejects.toThrow('incomplete');
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
  const store = fixtureWorkspace(root);
  const refreshIndex = vi.fn(async () => {});
  return {
    root,
    store,
    refreshIndex,
    async write(path: string, content: string | Buffer) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    },
    provider(paths: readonly string[], id = 'project', authority?: PinnedSourceAuthority) {
      return new FileSkillDiscoveryProvider({
        origin: { id, label: id, scope: 'project', compatibility: id },
        ...(authority ? { authority } : {}),
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

it.each([false, true])('bounds aggregate manifest reads including live verification (dirty=%s)', async dirty => {
  const fixture = await skillFixture();
  const names = Array.from({ length: 34 }, (_, index) => 'example-' + String(index).padStart(2, '0'));
  const reads = vi.spyOn(fixture.store, 'read').mockImplementation(async (path, options) => {
    const name = path.split('/').at(-2)!;
    const text = `---\nname: ${name}\ndescription: Example\n---\nBody`.padEnd(256 * 1024, ' ');
    expect(options?.maxBytes).toBe(Buffer.byteLength(text));
    if (dirty) expect(options?.physicalByteBudget).toBe(2 * 256 * 1024);
    return {
      path,
      text,
      revision: 'revision',
      byteOrderMark: false,
      byteLength: dirty ? 128 : Buffer.byteLength(text),
      ...(dirty ? { bytesRead: 2 * 256 * 1024 } : {}),
      mode: 0o644,
      identity: path,
    };
  });
  const found = await fixture.provider(names.map(name => '.glyph/skills/' + name + '/SKILL.md')).discover();
  expect(reads).toHaveBeenCalledTimes(dirty ? 16 : 32);
  expect(found.filter(skill => skill.status === 'active')).toHaveLength(dirty ? 16 : 32);
  expect(found.slice(-2).every(skill => skill.message?.includes('8 MiB'))).toBe(true);
});

it('checks every resource again after reconciling a concurrent publication', async () => {
  const fixture = await skillFixture();
  const entry = '.glyph/skills/example/SKILL.md';
  const resource = '.glyph/skills/example/references/notes.md';
  await fixture.write(entry, manifest());
  await fixture.write(resource, 'old');
  const provider = fixture.provider([entry, resource]);
  const [skill] = await provider.discover();
  await expect(provider.capture(skill!, undefined, () => fixture.write(resource, 'updated'))).rejects.toThrow(
    'changed during capture',
  );
  expect((await (await provider.capture(skill!)).readResource('references/notes.md')).content).toBe('updated');
});
