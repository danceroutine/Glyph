import { describe, expect, it, onTestFinished, vi } from 'vitest';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const candidate = { head_sha: base, head_branch: 'main', head_repository: { full_name: 'owner/repo' } };

async function invoke({
  runs = [candidate],
  apiError = false,
  nonAncestors = [],
  outputs = true,
  event = 'push',
  branch = 'main',
} = {}) {
  vi.stubEnv('GITHUB_EVENT_NAME', event);
  vi.stubEnv('GITHUB_REF', `refs/heads/${branch}`);
  vi.stubEnv('GITHUB_REPOSITORY', 'owner/repo');
  vi.stubEnv('GITHUB_SHA', head);
  vi.stubEnv('GITHUB_OUTPUT', outputs ? '/outputs' : '');
  const appendFile = vi.fn();
  const execFileSync = vi.fn((/** @type {string} */ command, /** @type {string[]} */ args) => {
    if (command === 'gh') {
      if (apiError) throw new Error('unavailable');
      return JSON.stringify({ workflow_runs: runs });
    }
    if (command === 'git') {
      if (nonAncestors.includes(args[2])) throw new Error('not an ancestor');
      return '';
    }
    return 'selection result\n';
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    stdout.mockRestore();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs/promises');
  });
  vi.resetModules();
  vi.doMock('node:child_process', () => ({ execFileSync }));
  vi.doMock('node:fs/promises', () => ({ appendFile }));
  await import('#scripts/coverage/select-main-electron-tests.mjs');
  return { execFileSync, appendFile, stdout };
}

describe('main integration baseline', () => {
  it('selects all changes since the most recent successful ancestor, not just the latest push', async () => {
    const { execFileSync, appendFile, stdout } = await invoke();
    expect(execFileSync.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [
        'gh',
        [
          'api',
          'repos/owner/repo/actions/workflows/integration.yml/runs?event=push&status=success&branch=main&per_page=100',
        ],
      ],
      ['git', ['merge-base', '--is-ancestor', base, head]],
      [
        process.execPath,
        [
          'scripts/coverage/select-electron-tests.mjs',
          '--base',
          base,
          '--output',
          '.artifacts/electron-selection.json',
        ],
      ],
    ]);
    expect(appendFile).toHaveBeenCalledWith('/outputs', `base=${base}\n`);
    expect(stdout).toHaveBeenCalledWith('selection result\n');
  });

  it('ignores other branches, repositories and non-ancestor heads', async () => {
    const newer = 'c'.repeat(40);
    const { execFileSync } = await invoke({
      runs: [
        { ...candidate, head_branch: 'feature' },
        { ...candidate, head_repository: { full_name: 'fork/repo' } },
        { ...candidate, head_sha: newer },
        candidate,
      ],
      nonAncestors: [newer],
    });
    expect(execFileSync.mock.calls.filter(call => call[0] === 'git').map(call => call[1][2])).toEqual([newer, base]);
    expect(execFileSync.mock.lastCall[1]).toContain(base);
  });

  it.each([
    { runs: [] },
    { apiError: true },
    { runs: [{ ...candidate, head_sha: 'invalid' }] },
    { nonAncestors: [base] },
  ])('falls back to full selection when no trustworthy baseline exists: %j', async options => {
    const { execFileSync, appendFile } = await invoke(options);
    expect(execFileSync.mock.lastCall[1]).toEqual([
      'scripts/coverage/select-electron-tests.mjs',
      '--output',
      '.artifacts/electron-selection.json',
    ]);
    expect(appendFile).toHaveBeenCalledWith('/outputs', `base=${'0'.repeat(40)}\n`);
  });

  it('does not require an Actions output file', async () => {
    const { appendFile } = await invoke({ outputs: false });
    expect(appendFile).not.toHaveBeenCalled();
  });

  it.each([{ event: 'pull_request' }, { event: 'workflow_dispatch' }, { branch: 'feature' }])(
    'rejects non-main-push contexts: %j',
    async options => {
      await expect(invoke(options)).rejects.toThrow();
    },
  );
});
