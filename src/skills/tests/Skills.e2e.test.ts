import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { FileSystemWorkspaceTextStore } from '#src/workspace/FileSystemWorkspaceTextStore.js';
import { RustWorkspacePathIndex } from '#src/context/search/RustWorkspacePathIndex.js';
import { TurnContextCoordinator } from '#src/context/turns/TurnContextCoordinator.js';
import { FileSkillDiscoveryProvider } from '#src/skills/FileSkillDiscoveryProvider.js';
import { SkillCatalog } from '#src/skills/SkillCatalog.js';
import { SkillContextContributor } from '#src/skills/SkillContextContributor.js';
import { SkillToolRuntime } from '#src/skills/SkillToolRuntime.js';
import { OpenAIProvider } from '#src/providers/openai/OpenAIProvider.js';

// These files are untrusted fixture data. Reading a script must never execute it.
const entry =
  '---\nname: example\ndescription: Use for fixture examples\n---\nPINNED BODY: read references/notes.md when needed.';

describe('Native skills discovery and model disclosure', () => {
  it('discovers indexed native/compatibility packages, rejects excluded paths, and observes external updates', async () => {
    const fixture = await nativeSkillFixture();
    await fixture.write('.glyph/skills/example/SKILL.md', entry);
    await fixture.write('docs/.glyph/skills/example/SKILL.md', entry);
    await fixture.write('.cursor/skills/example/SKILL.md', entry);
    await fixture.write('.claude/skills/example/SKILL.md', entry);
    await fixture.write('node_modules/.glyph/skills/example/SKILL.md', entry);
    await fixture.write('.glyph/skills/example/references/notes.md', 'ORIGINAL RESOURCE');
    await symlink(join(fixture.root, '.glyph/skills/example'), join(fixture.root, '.glyph/skills/linked'), 'dir');
    const native = fixture.provider('.glyph/skills', 'native');
    const compatible = fixture.provider('.cursor/skills', 'cursor');
    // Registering another location tests the extension point; production does not enable Claude discovery yet.
    const future = fixture.provider('.claude/skills', 'claude');
    const catalog = new SkillCatalog([native, compatible, future]);
    const sources = await catalog.refresh();
    expect(sources).toHaveLength(4);
    expect(sources.every(source => source.status === 'active')).toBe(true);
    expect(sources.some(source => source.path.includes('node_modules') || source.path.includes('linked'))).toBe(false);
    const source = sources.find(candidate => candidate.path === '.glyph/skills/example/SKILL.md')!;
    const coordinator = new TurnContextCoordinator([new SkillContextContributor(catalog)]);
    const first = await coordinator.beginTurn({ turnId: 'first', attachmentPaths: [], skillIds: [source.id] });
    expect(first.initialEnvelope().skills?.[0]?.body).toContain('PINNED BODY');
    await fixture.write('.glyph/skills/example/SKILL.md', entry.replace('PINNED BODY', 'UPDATED BODY'));
    await fixture.write('.glyph/skills/example/references/notes.md', 'UPDATED RESOURCE');
    await catalog.refresh();
    const session = coordinator.contribution('first', 'skills');
    if (!session || !('readResource' in session) || typeof session.readResource !== 'function')
      throw new Error('Missing skill session');
    expect(await session.readResource(source.id, 'references/notes.md')).toMatchObject({
      content: 'ORIGINAL RESOURCE',
    });
    const second = await coordinator.beginTurn({ turnId: 'second', attachmentPaths: [], skillIds: [source.id] });
    expect(second.initialEnvelope().skills?.[0]?.body).toContain('UPDATED BODY');
    await fixture.write('new/.glyph/skills/example/SKILL.md', entry);
    await expect
      .poll(
        async () =>
          (await catalog.refresh()).some(candidate => candidate.path === 'new/.glyph/skills/example/SKILL.md'),
        { timeout: 10_000 },
      )
      .toBe(true);
    expect(fixture.list).not.toHaveBeenCalled();
  });

  it('advertises the case-insensitive native scope and withholds an ignored manifest beside an indexed resource', async () => {
    const fixture = await nativeSkillFixture(false);
    await mkdir(join(fixture.root, '.git'));
    await fixture.write('.gitignore', 'ignored/.glyph/skills/example/SKILL.md\n');
    await fixture.write('Src/.GLYPH/Skills/example/sKiLl.Md', entry);
    await fixture.write('ignored/.glyph/skills/example/SKILL.md', entry);
    await fixture.write('ignored/.glyph/skills/example/notes.md', 'Visible resource');
    const catalog = new SkillCatalog([fixture.provider('.glyph/skills', 'glyph')]);
    const session = await new SkillContextContributor(catalog).beginTurn({
      turnId: 'mixed',
      attachmentPaths: ['src/task.ts', 'ignored/file.ts'],
    });
    expect(catalog.skills.find(source => source.scope === 'ignored')).toMatchObject({
      status: 'error',
      uri: '',
      enabled: false,
    });
    const candidates = session.initialEnvelope().skillCandidates;
    expect(candidates).toHaveLength(1);
    expect(candidates![0]?.scope).toBe('Src');
    const activation = await session.activateSource(candidates![0]!.id, 'model', 'Task');
    expect(activation?.skills?.[0]?.body).toContain('PINNED BODY');
  });

  it('sends metadata, activated instructions, and requested resources progressively through the production provider', async () => {
    const fixture = await nativeSkillFixture();
    await fixture.write('.glyph/skills/example/SKILL.md', entry);
    await fixture.write('.glyph/skills/example/references/notes.md', 'RESOURCE BODY');
    await fixture.write('.glyph/skills/example/scripts/do-not-run.sh', 'echo NEVER_EXECUTE_FIXTURE_SCRIPT');
    const catalog = new SkillCatalog([fixture.provider('.glyph/skills', 'native')]);
    const [source] = await catalog.refresh();
    const coordinator = new TurnContextCoordinator([new SkillContextContributor(catalog)]);
    const requests: { input: unknown }[] = [];
    const outputs = [
      [
        {
          type: 'function_call',
          id: 'activate-item',
          call_id: 'activate-call',
          namespace: 'skills',
          name: 'activate',
          arguments: JSON.stringify({ id: source!.id, reason: 'The fixture task needs this workflow' }),
        },
      ],
      [
        {
          type: 'function_call',
          id: 'read-item',
          call_id: 'read-call',
          namespace: 'skills',
          name: 'read_resource',
          arguments: JSON.stringify({ id: source!.id, path: 'references/notes.md' }),
        },
      ],
    ];
    const client = new OpenAI({
      apiKey: 'fixture',
      maxRetries: 0,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '') as { input: unknown });
        const output = outputs.shift() ?? [
          {
            type: 'message',
            id: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
          },
        ];
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const provider = new OpenAIProvider(
      'fixture',
      { instructions: 'Fixture instructions', timeoutMs: 10_000 },
      async () => 'fixture',
      client,
      new SkillToolRuntime(coordinator),
      undefined,
      coordinator,
    );
    const result = await provider.send('Use the relevant workflow.', {
      signal: new AbortController().signal,
      onText: () => {},
    });
    expect(JSON.stringify(requests[0])).toContain('Use for fixture examples');
    expect(JSON.stringify(requests[0])).not.toContain('PINNED BODY');
    expect(JSON.stringify(requests[1])).toContain('PINNED BODY');
    expect(JSON.stringify(requests[1])).not.toContain('RESOURCE BODY');
    expect(JSON.stringify(requests[2])).toContain('RESOURCE BODY');
    expect(JSON.stringify(requests)).not.toContain('NEVER_EXECUTE_FIXTURE_SCRIPT');
    expect(result.context?.skills?.[0]?.resources.map(resource => resource.path)).toEqual(['references/notes.md']);
    expect(JSON.stringify(provider.exportState())).not.toContain('PINNED BODY');
    expect(JSON.stringify(provider.exportState())).not.toContain('RESOURCE BODY');
    await provider.send('An unrelated next turn.', { signal: new AbortController().signal, onText: () => {} });
    expect(JSON.stringify(requests[3])).not.toContain('PINNED BODY');
    expect(fixture.list).not.toHaveBeenCalled();
  });
});

async function nativeSkillFixture(caseSensitive?: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'glyph-native-skills-'));
  const store = new FileSystemWorkspaceTextStore(root, caseSensitive !== undefined ? { caseSensitive } : {});
  const index = new RustWorkspacePathIndex({
    root,
    caseSensitive: store.caseSensitive,
    binaryPath: resolve(
      'target/release',
      process.platform === 'win32' ? 'glyph-context-index.exe' : 'glyph-context-index',
    ),
  });
  const list = vi.spyOn(store, 'list').mockRejectedValue(new Error('Use the native index.'));
  onTestFinished(async () => {
    await index.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    list,
    async write(path: string, text: string) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    },
    provider(directory: string, id: string) {
      return new FileSkillDiscoveryProvider({
        origin: { id, label: id, scope: 'project', compatibility: id },
        directory,
        workspace: store,
        binaryStore: store,
        uriForPath: path => pathToFileURL(join(root, path)).href,
        listFiles: signal => index.glob(`**/${directory}/**/*`, { limit: 1000, ...(signal ? { signal } : {}) }),
        refreshIndex: async () => {
          await index.refresh();
        },
      });
    },
  };
}
