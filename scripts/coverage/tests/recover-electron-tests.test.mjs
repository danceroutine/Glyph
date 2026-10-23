import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';

const context = {
  repository: 'owner/repo',
  branch: 'main',
  head: 'a'.repeat(40),
  base: 'b'.repeat(40),
  platform: `Linux-X64-ubuntu24-20261022-node${process.version}`,
  playwright: '1.61.1',
};
const evidence = {
  id: 'web',
  file: 'GlyphWeb.test.mjs',
  titles: ['web'],
  expectedStatus: 'passed',
  status: 'expected',
  clean: true,
};
const manifest = { version: 1, context, run: '1', attempt: '1', passed: [evidence] };
const report = {
  config: { version: '1.61.1' },
  errors: [],
  suites: [
    {
      title: 'GlyphWeb.test.mjs',
      specs: [
        {
          id: 'web',
          file: 'GlyphWeb.test.mjs',
          title: 'web',
          tests: [
            {
              projectName: '',
              expectedStatus: 'passed',
              status: 'expected',
              results: [{ status: 'passed', retry: 0, errors: [] }],
            },
          ],
        },
      ],
    },
  ],
};
const candidate = {
  id: 1,
  run_attempt: 1,
  head_sha: context.head,
  head_repository: { full_name: context.repository },
  head_branch: 'main',
};
const plan = {
  version: 1,
  context,
  run: '2',
  attempt: '1',
  sourceRun: null,
  reason: 'test',
  required: [evidence],
  reused: [],
  remaining: ['web'],
  execute: true,
};

async function invoke({
  mode = 'prepare',
  attempt = '1',
  branch = 'main',
  event = 'push',
  outputs = true,
  runs = [candidate],
  prior = manifest,
  artifactError = false,
  apiError = false,
  gitError = false,
  inventory = report,
  result = report,
  savedPlan = plan,
  changed = '',
} = {}) {
  const argv = process.argv;
  process.argv = ['node', 'recover-electron-tests.mjs', mode];
  for (const [key, value] of Object.entries({
    GITHUB_REPOSITORY: context.repository,
    GITHUB_RUN_ID: '2',
    GITHUB_RUN_ATTEMPT: attempt,
    GITHUB_EVENT_NAME: event,
    GITHUB_REF: `refs/heads/${branch}`,
    GITHUB_SHA: context.head,
    INTEGRATION_BASE_SHA: context.base,
    RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64',
    ImageOS: 'ubuntu24',
    ImageVersion: '20261022',
    GITHUB_OUTPUT: outputs ? '/outputs' : '',
    GITHUB_STEP_SUMMARY: outputs ? '/summary' : '',
  }))
    vi.stubEnv(key, value);
  const filesystem = {
    mkdir: vi.fn(),
    rm: vi.fn(),
    writeFile: vi.fn(async (/** @type {string} */ _path, /** @type {string} */ _value) => {}),
    appendFile: vi.fn(),
    readFile: vi.fn(async (/** @type {string} */ path) => {
      if (path.endsWith('inventory.json')) return JSON.stringify(inventory);
      if (path.endsWith('manifest.json')) return JSON.stringify(prior);
      if (path.endsWith('plan.json')) return JSON.stringify(savedPlan);
      if (path.endsWith('results.json')) {
        if (result === null) throw new Error('no report');
        return JSON.stringify(result);
      }
      return JSON.stringify({ rules: [{ area: 'web', prefixes: ['src/web/'], tests: ['GlyphWeb'] }] });
    }),
  };
  const execFileSync = vi.fn(
    (
      /** @type {string} */ command,
      /** @type {string[]} */ args,
      /** @type {{ env: NodeJS.ProcessEnv }} */ _options,
    ) => {
      if (command === 'gh') {
        if (args[0] === 'api') {
          if (apiError) throw new Error('no permission');
          return JSON.stringify({ workflow_runs: runs });
        }
        if (artifactError) throw new Error('expired artifact');
        return '';
      }
      if (command === 'git') {
        if (args[0] === 'ls-files') return 'code-oss/tests/electron/GlyphWeb.test.mjs\0';
        if (gitError) throw new Error('history unavailable');
        return args[0] === 'diff' ? changed : '';
      }
      return '';
    },
  );
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  onTestFinished(() => {
    process.argv = argv;
    vi.unstubAllEnvs();
    stdout.mockRestore();
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('node:child_process');
  });
  vi.resetModules();
  vi.doMock('node:fs/promises', () => filesystem);
  vi.doMock('node:child_process', () => ({ execFileSync }));
  const loaded = import('#scripts/coverage/recover-electron-tests.mjs');
  return {
    loaded,
    filesystem,
    execFileSync,
    json: (/** @type {string} */ name) =>
      z
        .object({
          version: z.number().optional(),
          run: z.string().optional(),
          sourceRun: z.string().nullable().optional(),
          execute: z.boolean().optional(),
          reused: z.array(z.unknown()).optional(),
          passed: z.array(z.unknown()).optional(),
          remaining: z.array(z.string()).optional(),
          failedTests: z.array(z.string()).optional(),
          status: z.string().optional(),
        })
        .parse(JSON.parse(filesystem.writeFile.mock.calls.find(([path]) => path.endsWith(name))[1])),
  };
}

describe('Electron recovery CLI', () => {
  it('can recover the previous attempt of the same GitHub run', async () => {
    const run = await invoke({ attempt: '2', runs: [], prior: { ...manifest, run: '2' } });
    await run.loaded;
    expect(run.json('plan.json')).toMatchObject({ sourceRun: '2', execute: false });
    expect(run.execFileSync.mock.calls.find(([command, args]) => command === 'gh' && args[0] === 'run')[1]).toContain(
      'electron-recovery-2-1',
    );
  });

  it('restores main evidence and emits exact-ID selection and an auditable plan', async () => {
    const run = await invoke();
    await run.loaded;
    expect(run.json('plan.json')).toMatchObject({
      execute: false,
      reused: [expect.objectContaining({ id: 'web' })],
      sourceRun: '1',
    });
    expect(run.json('last-run.json')).toEqual({ status: 'failed', failedTests: [] });
    expect(run.execFileSync.mock.calls).toContainEqual([
      'git',
      ['merge-base', '--is-ancestor', context.head, context.head],
      expect.anything(),
    ]);
    expect(run.execFileSync.mock.calls[0][2].env.PLAYWRIGHT_JSON_OUTPUT_FILE).toMatch(
      /electron-recovery\/inventory.json$/u,
    );
    expect(run.execFileSync.mock.calls[1][1][1]).toContain(
      'integration.yml/runs?event=push&status=completed&branch=main',
    );
    expect(run.filesystem.rm).toHaveBeenCalledWith(expect.stringContaining('/electron-recovery/results.json'), {
      force: true,
    });
    expect(run.filesystem.appendFile).toHaveBeenCalledWith('/outputs', 'execute=false\n');
  });
  it('diffs intervening commits with NUL separation and invalidates affected passes', async () => {
    const run = await invoke({ changed: 'src/web/file with spaces.ts\0' });
    await run.loaded;
    expect(run.json('plan.json').execute).toBe(true);
    expect(run.json('last-run.json').failedTests).toEqual(['web']);
  });
  it.each([{ apiError: true }, { artifactError: true }, { prior: {} }, { gitError: true }, { runs: [] }])(
    'falls back to running tests on unavailable evidence: %j',
    async options => {
      const run = await invoke(options);
      await run.loaded;
      expect(run.json('plan.json')).toMatchObject({ reused: [], execute: true });
    },
  );
  it.each([
    { ...candidate, head_repository: { full_name: 'other/repo' } },
    { ...candidate, head_branch: 'feature' },
  ])('does not download another repository or branch artifact: %j', async otherRun => {
    const run = await invoke({ runs: [otherRun] });
    await run.loaded;
    expect(run.execFileSync.mock.calls.filter(([command, args]) => command === 'gh' && args[0] === 'run')).toEqual([]);
  });
  it.each([
    { ...manifest, run: '3' },
    { ...manifest, attempt: '3' },
    { ...manifest, context: { ...context, head: 'c'.repeat(40) } },
    { ...manifest, context: { ...context, repository: 'other/repo' } },
    { ...manifest, context: { ...context, branch: 'feature' } },
  ])('rejects artifacts that disagree with GitHub provenance: %j', async prior => {
    const run = await invoke({ prior });
    await run.loaded;
    expect(run.json('plan.json').reused).toEqual([]);
  });
  it('supports missing GitHub output files without losing the saved plan', async () => {
    const run = await invoke({ outputs: false });
    await run.loaded;
    expect(run.filesystem.appendFile).not.toHaveBeenCalled();
    expect(run.json('plan.json').version).toBe(1);
  });
  it.each([{ branch: 'feature' }, { event: 'pull_request' }, { event: 'workflow_dispatch' }])(
    'refuses recovery outside a main push: %j',
    async options => {
      const run = await invoke(options);
      await expect(run.loaded).rejects.toThrow();
      expect(run.execFileSync).not.toHaveBeenCalled();
    },
  );
  it('fails closed on empty inventory', async () => {
    const run = await invoke({ inventory: { ...report, suites: [] } });
    await expect(run.loaded).rejects.toThrow('inventory is empty');
  });
  it('records only clean successes after execution', async () => {
    const run = await invoke({ mode: 'finish' });
    await run.loaded;
    expect(run.json('manifest.json')).toMatchObject({ run: '2', passed: [expect.objectContaining({ id: 'web' })] });
    expect(run.execFileSync).not.toHaveBeenCalled();
  });
  it.each([null, {}])('retains evidence and fails on missing or invalid results: %j', async result => {
    const run = await invoke({ mode: 'finish', result });
    await expect(run.loaded).rejects.toThrow('did not report every planned test');
    expect(run.json('manifest.json').passed).toEqual([]);
  });
  it('finishes a fully reused run without requiring an execution report', async () => {
    const run = await invoke({
      mode: 'finish',
      result: null,
      savedPlan: { ...plan, reused: [evidence], remaining: [], execute: false },
      outputs: false,
    });
    await run.loaded;
    expect(run.json('manifest.json').passed).toHaveLength(1);
    expect(run.filesystem.appendFile).not.toHaveBeenCalled();
  });
  it('rejects unknown operations', async () => {
    const run = await invoke({ mode: 'unknown' });
    await expect(run.loaded).rejects.toThrow('Use prepare or finish');
  });
});
