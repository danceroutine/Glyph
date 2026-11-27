import { describe, expect, it, vi } from 'vitest';
import { SkillPackage, captureSkillPackage } from '#src/skills/SkillPackage.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';
import { SkillContextContributor, SkillTurnContext } from '#src/skills/SkillContextContributor.js';
import { SkillToolRuntime } from '#src/skills/SkillToolRuntime.js';
import { skillActivationSchema, skillDescriptorSchema } from '#src/skills/SkillSchemas.js';
import { parseSkillManifest } from '#src/skills/SkillManifest.js';
import { aWorkspaceTextSnapshot } from '#src/workspace/tests/fixtures/aWorkspaceTextSnapshot.js';
import type { WorkspaceTextStore } from '#src/workspace/WorkspaceTextStore.js';
import { aSkillDescriptor, aSkillPackage } from './fixtures/aSkillDescriptor.ts';

describe('Skill package boundaries', async () => {
  it.each(['../outside', '/outside', 'dir\\outside', 'bad\0path', ''])('rejects resource path %j', async path => {
    await expect(aSkillPackage().readResource(path)).rejects.toThrow('inside');
  });
  it('rejects oversized disclosure before recording it as used', async () => {
    const snapshot = aSkillPackage(aSkillDescriptor(), 'Body', { 'large.md': Buffer.alloc(64 * 1024 + 1, 65) });
    await expect(snapshot.readResource('large.md')).rejects.toThrow('budget');
    expect(snapshot.resources()).toEqual([]);
    const nul = aSkillPackage(aSkillDescriptor(), 'Body', { nul: Buffer.from([0, 1]) });
    expect((await nul.readResource('nul')).encoding).toBe('base64');
  });
  it('discloses UTF-8 resource bytes including the leading byte-order mark', async () => {
    const source = '\uFEFFprint("example")\n';
    const bytes = Buffer.from(source);
    const snapshot = aSkillPackage(aSkillDescriptor(), 'Body', { 'script.py': bytes });
    const result = await snapshot.readResource('script.py');
    expect(result.encoding).toBe('utf8');
    expect(Buffer.from(result.content)).toEqual(bytes);
    expect(snapshot.resources()).toEqual([result]);
  });
  it('keeps resource inspection separate from recorded model disclosures', async () => {
    const snapshot = aSkillPackage(aSkillDescriptor(), 'Body', { 'script.sh': Buffer.from('exit 0') });
    const inspected = snapshot.inspectResource('script.sh');
    expect(inspected.content).toBe('exit 0');
    expect(snapshot.resources()).toEqual([]);
    expect(await snapshot.readResource('script.sh')).toEqual(inspected);
    expect(snapshot.resources()).toEqual([inspected]);
  });
  it('checks containment before reading and enforces manifest, file-count, and aggregate limits', async () => {
    const descriptor = aSkillDescriptor();
    const read = vi.fn<WorkspaceTextStore['read']>(async path =>
      aWorkspaceTextSnapshot({ path, text: 'x'.repeat(1024 * 1024) }),
    );
    const store = { read };
    await expect(captureSkillPackage(descriptor, store, ['outside.md'])).rejects.toThrow('escaped');
    expect(read).not.toHaveBeenCalled();
    await expect(
      captureSkillPackage(
        descriptor,
        store,
        Array.from({ length: 257 }, () => descriptor.path),
      ),
    ).rejects.toThrow('256 files');
    await expect(captureSkillPackage(descriptor, store, [])).rejects.toThrow('missing SKILL.md');
    await expect(
      captureSkillPackage(
        descriptor,
        store,
        Array.from({ length: 9 }, (_, i) => `${descriptor.directory}/${i}.md`),
      ),
    ).rejects.toThrow('8 MiB');
    const controller = new AbortController();
    controller.abort(new Error('Cancelled'));
    await expect(captureSkillPackage(descriptor, store, [descriptor.path], controller.signal)).rejects.toThrow(
      'Cancelled',
    );
  });
  it('captures text-only stores including BOM without relying on a filesystem implementation', async () => {
    const descriptor = aSkillDescriptor({ revision: 'bom' });
    const read = vi.fn<WorkspaceTextStore['read']>(async path =>
      aWorkspaceTextSnapshot({
        path,
        text: '---\nname: example\ndescription: Examples\n---\nBody',
        revision: 'bom',
        byteOrderMark: true,
      }),
    );
    const snapshot = await captureSkillPackage(descriptor, { read }, [descriptor.path]);
    expect(snapshot).toBeInstanceOf(SkillPackage);
    expect(snapshot.body).toBe('Body');
  });
  it('validates optional metadata and rejects oversized frontmatter', () => {
    expect(
      parseSkillManifest(
        '---\nname: example\ndescription: Example\nlicense: MIT\ncompatibility: Requires Python\n---\nBody',
        'example',
      ),
    ).toMatchObject({ license: 'MIT', compatibility: 'Requires Python', metadata: {}, allowedTools: [] });
    expect(() =>
      parseSkillManifest(`---\nname: example\ndescription: Example\n# ${'x'.repeat(16 * 1024)}\n---\nBody`, 'example'),
    ).toThrow('16 KiB');
    const descriptor = aSkillDescriptor({ compatibility: 'Python', message: 'Diagnostic' });
    expect(skillDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    const { revision: _, ...unversioned } = aSkillDescriptor();
    const activation = {
      descriptor: unversioned,
      revision: 'package',
      reason: 'manual',
      explanation: 'Selected',
      body: 'Body',
      resources: [],
    };
    expect(skillActivationSchema.parse(activation)).toMatchObject({ body: 'Body', descriptor: { name: 'example' } });
  });
  it('keeps the newest completed refresh when an old inventory resolves late', async () => {
    const source = aSkillDescriptor();
    let resolveOlder!: (value: (typeof source)[]) => void;
    const older = new Promise<(typeof source)[]>(resolve => {
      resolveOlder = resolve;
    });
    const discover = vi.fn().mockReturnValueOnce(older).mockResolvedValueOnce([source]);
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: source.origin,
        discover,
        capture: async () => aSkillPackage(),
        refreshIndex: async () => {},
      },
    ]);
    const change = vi.fn();
    catalog.onDidChange(change);
    const pending = catalog.refresh();
    expect(await catalog.refresh()).toEqual([source]);
    resolveOlder([]);
    expect(await pending).toEqual([source]);
    expect(catalog.skills).toEqual([source]);
    expect(change).toHaveBeenCalledOnce();
  });
  it('keeps an unavailable provider separate from valid packages and propagates cancellation', async () => {
    const descriptor = aSkillDescriptor();
    const controller = new AbortController();
    const provider = {
      id: 'project',
      origin: aSkillDescriptor().origin,
      discover: async () => {
        controller.abort(new Error('Cancelled'));
        throw new Error('Cancelled');
      },
      capture: async () => aSkillPackage(),
      refreshIndex: async () => {},
    };
    await expect(new SkillCatalog([provider]).refresh(controller.signal)).rejects.toThrow('Cancelled');
    const catalog = new SkillCatalog([]);
    expect(catalog.skills).toEqual([]);
    await expect(catalog.capture(descriptor)).rejects.toThrow('provider');
    const failed = await new SkillCatalog([
      {
        ...provider,
        origin: { ...descriptor.origin, scope: 'user', label: 'User location' },
        discover: async () => {
          throw 'Unavailable';
        },
      },
    ]).refresh();
    expect(failed[0]).toMatchObject({
      status: 'discovery-error',
      origin: { scope: 'user', label: 'User location', compatibility: 'glyph' },
      uri: '',
      message: 'Skill discovery failed.',
    });
  });
});

describe('Skill turn limits and tool authority', () => {
  it('reports unavailable manual selections while ignoring unknown model-selected IDs', async () => {
    const catalog = new SkillCatalog([]);
    await expect(
      new SkillContextContributor(catalog).beginTurn({ turnId: 'missing', attachmentPaths: [], skillIds: ['missing'] }),
    ).rejects.toThrow('Selected skill is unavailable');
    const session = new SkillTurnContext('model', [], [], catalog);
    expect(await session.activateSource('missing', 'model', 'Not advertised')).toBeUndefined();
  });

  it('normalizes each offered path once per origin and preserves order for repeated and overlapping scopes', async () => {
    const key = vi.fn((path: string) => path.toLowerCase());
    const scopes = ['src/nested', 'src', 'none', 'src', '.'];
    const skills = scopes.map((scope, i) => aSkillDescriptor({ id: String(i), scope }));
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: skills[0]!.origin,
        scopePathKey: key,
        discover: async () => skills,
        capture: async skill => aSkillPackage(skill),
        refreshIndex: async () => {},
      },
    ]);
    const paths = Array.from({ length: 100 }, (_, i) => 'SRC/NESTED/' + i);
    expect(catalog.applicableSkills(skills, [...paths, ...paths]).map(skill => skill.id)).toEqual(['0', '1', '3', '4']);
    expect(key).toHaveBeenCalledTimes(103);
    const capped = Array.from({ length: 51 }, (_, i) => aSkillDescriptor({ id: String(i), name: String(i) }));
    const session = new SkillTurnContext('capped', capped, capped, catalog);
    expect(session.initialEnvelope().skillCandidates).toHaveLength(50);
    expect(session.disclosePaths(paths)).toBeUndefined();
  });
  it('caps catalog metadata and activated bodies, while explicit user selection remains independent of model advertising', async () => {
    const sources = Array.from({ length: 60 }, (_, i) =>
      aSkillDescriptor({ id: `skill-${i}`, name: `example-${i}`, description: 'x'.repeat(1024) }),
    );
    let body = 'Body';
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: aSkillDescriptor().origin,
        discover: async () => sources,
        capture: async descriptor => aSkillPackage(descriptor, body),
        refreshIndex: async () => {},
      },
    ]);
    const session = await new SkillContextContributor(catalog).beginTurn({ turnId: 'limits', attachmentPaths: [] });
    expect(Buffer.byteLength(JSON.stringify(session.initialEnvelope().skillCandidates))).toBeLessThanOrEqual(32 * 1024);
    expect(session.initialEnvelope().skillCandidates!.length).toBeLessThan(50);
    await session.activateSource('skill-59', 'manual', 'Explicit selection');
    for (let i = 0; i < 31; i++) await session.activateSource(`skill-${i}`, 'manual', 'Explicit selection');
    await expect(session.activateSource('skill-58', 'manual', 'One too many')).rejects.toThrow('32 skills');
    body = 'x'.repeat(64 * 1024 + 1);
    const large = new SkillTurnContext('large', sources, sources.slice(0, 1), catalog);
    await expect(large.activateSource('skill-0', 'model', 'Task')).rejects.toThrow('64 KiB');
  });
  it('activates nested attachment scope and coalesces concurrent duplicate activation', async () => {
    const descriptor = aSkillDescriptor({ scope: 'docs' });
    const catalog = new SkillCatalog([
      {
        id: 'project',
        origin: aSkillDescriptor().origin,
        discover: async () => [descriptor],
        capture: async source => aSkillPackage(source),
        refreshIndex: async () => {},
      },
    ]);
    const session = await new SkillContextContributor(catalog).beginTurn({
      turnId: 'attached',
      attachmentPaths: ['src/file.ts', 'docs/file.ts', 'docs'],
    });
    expect(session.initialEnvelope().skillCandidates?.[0]?.id).toBe(descriptor.id);
    const first = session.activateSource(descriptor.id, 'model', 'Task');
    const duplicate = session.activateSource(descriptor.id, 'model', 'Task');
    expect((await first)?.skills).toHaveLength(1);
    expect(await duplicate).toBeUndefined();
  });
  it('rejects missing turn authority, unknown sessions, invalid inputs, and unadvertised activation', async () => {
    const runtime = new SkillToolRuntime({ activateSource: vi.fn(async () => undefined), contribution: vi.fn() });
    const [activate, read] = runtime.tools;
    activate!.validateInput(JSON.stringify({ id: 'skill', reason: 'Task' }));
    read!.validateInput(JSON.stringify({ id: 'skill', path: 'reference.md' }));
    expect(() => {
      activate!.validateInput('{}');
    }).toThrow();
    expect(() => {
      read!.validateInput('{}');
    }).toThrow();
    const signal = new AbortController().signal;
    await expect(activate!.execute(JSON.stringify({ id: 'skill', reason: 'Task' }), signal, {})).rejects.toThrow(
      'active turn',
    );
    await expect(read!.execute(JSON.stringify({ id: 'skill', path: 'reference.md' }), signal, {})).rejects.toThrow(
      'active turn',
    );
    await expect(
      read!.execute(JSON.stringify({ id: 'skill', path: 'reference.md' }), signal, { turnId: 'unknown' }),
    ).rejects.toThrow('unavailable');
    expect(
      JSON.parse(
        await activate!.execute(JSON.stringify({ id: 'skill', reason: 'Task' }), signal, { turnId: 'unknown' }),
      ),
    ).toMatchObject({ activated: false });
  });
});

it('keeps cancellation distinct from actionable resource failures, including non-Error provider failures', async () => {
  const turns = { activateSource: vi.fn().mockRejectedValue('Provider unavailable'), contribution: vi.fn() };
  const runtime = new SkillToolRuntime(turns);
  const activation = runtime.tools[0]!;
  await expect(
    activation.execute(JSON.stringify({ id: 'example', reason: 'Relevant' }), new AbortController().signal, {
      turnId: 'turn',
    }),
  ).rejects.toThrow('Skill operation failed.');
  const controller = new AbortController();
  controller.abort(new Error('Cancelled instruction request'));
  await expect(
    activation.execute(JSON.stringify({ id: 'example', reason: 'Relevant' }), controller.signal, { turnId: 'turn' }),
  ).rejects.toThrow('Cancelled instruction request');
});

it('keeps the preferred provider when an older catalog finishes its preference migration later', async () => {
  const source = aSkillDescriptor();
  const provider = {
    origin: source.origin,
    id: source.origin.id,
    discover: async () => [source, { ...source, directory: 'nested/' + source.directory }],
    capture: async () => aSkillPackage(),
    refreshIndex: async () => {},
  };
  let resume!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => {
    started = resolve;
  });
  const blocked = new Promise<void>(resolve => {
    resume = resolve;
  });
  const migrate = vi
    .fn(async () => {})
    .mockImplementationOnce(async () => {
      started();
      await blocked;
    });
  const catalog = new SkillCatalog(
    [provider],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    migrate,
  );
  const first = catalog.refresh();
  await waiting;
  await catalog.refresh();
  resume();
  expect(await first).toEqual([source]);
});
