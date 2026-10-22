import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const sourceRoot = join(repositoryRoot, '.code-oss', 'src');
const runtimeRoot = join(repositoryRoot, '.code-oss', 'node-runtime');
const nodeBinary = join(runtimeRoot, 'node_modules', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const marker = join(sourceRoot, '.glyph-upstream.json');

/**
 * @param {string[]} argv
 * @param {{
 *   missing?: string[],
 *   statError?: unknown,
 *   spawnResults?: { status?: number | null, error?: unknown }[],
 *   removedHooks?: string[][],
 * }} [options]
 */
async function runScript(argv, { missing = [], statError, spawnResults = [], removedHooks = [] } = {}) {
  /** @type {unknown[][]} */
  const events = [];
  const filesystem = {
    readFile: vi.fn(async () => JSON.stringify({ node: '22.0.0' })),
    stat: vi.fn(async (/** @type {string} */ path) => {
      if (statError !== undefined) throw statError;
      if (missing.includes(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {};
    }),
  };
  const childProcess = {
    spawnSync: vi.fn(
      (
        /** @type {string} */ executable,
        /** @type {string[]} */ arguments_,
        /** @type {{ cwd: string, stdio: string, env: NodeJS.ProcessEnv }} */ _options,
      ) => {
        events.push(['spawn', executable, ...arguments_]);
        return spawnResults.shift() ?? { status: 0 };
      },
    ),
  };
  const hooks = {
    removeLeakedCodeOssHuskyHooks: vi.fn(async (/** @type {string} */ root) => {
      events.push(['clean', root]);
      return removedHooks.shift() ?? [];
    }),
  };
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const originalArgv = process.argv;
  onTestFinished(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    stdout.mockRestore();
    stderr.mockRestore();
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('node:child_process');
    vi.doUnmock('#scripts/code-oss/git-hooks.mjs');
  });
  process.argv = ['node', 'run.mjs', ...argv];
  vi.resetModules();
  vi.doMock('node:fs/promises', () => filesystem);
  vi.doMock('node:child_process', () => childProcess);
  vi.doMock('#scripts/code-oss/git-hooks.mjs', () => hooks);
  await import('#scripts/code-oss/run.mjs');
  return { events, filesystem, childProcess, stdout, stderr, exitCode: process.exitCode };
}

describe('run', () => {
  it('reads the pinned Node version from the upstream pin', async () => {
    const run = await runScript(['run', 'compile'], { missing: [nodeBinary] });

    expect(run.filesystem.readFile).toHaveBeenCalledWith(join(repositoryRoot, 'code-oss', 'upstream.json'), 'utf8');
    expect(run.events[1]).toEqual(['spawn', 'npm', 'install', '--prefix', runtimeRoot, 'node@22.0.0']);
  });

  it('refuses to run before the generated checkout is bootstrapped', async () => {
    const run = await runScript(['install'], { missing: [marker] });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toHaveBeenCalledWith('Run pnpm code-oss:bootstrap first.');
    expect(run.events).toEqual([['clean', repositoryRoot]]);
  });

  it('installs upstream dependencies with the pinned runtime and a sanitized environment', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    vi.stubEnv('VSCODE_CLI', '1');
    vi.stubEnv('VSCODE_ESM_ENTRYPOINT', 'entry');
    vi.stubEnv('VSCODE_IPC_HOOK', 'hook');
    vi.stubEnv('PATH', '/usr/bin');
    onTestFinished(() => vi.unstubAllEnvs());

    const run = await runScript(['install']);

    expect(run.events).toEqual([
      ['clean', repositoryRoot],
      ['spawn', 'npm', 'install'],
      ['clean', repositoryRoot],
    ]);
    const [, , options] = run.childProcess.spawnSync.mock.calls[0];
    expect(options.cwd).toBe(sourceRoot);
    expect(options.stdio).toBe('inherit');
    expect(options.env.PATH).toBe(`${join(runtimeRoot, 'node_modules', 'node', 'bin')}${delimiter}/usr/bin`);
    for (const name of ['ELECTRON_RUN_AS_NODE', 'VSCODE_CLI', 'VSCODE_ESM_ENTRYPOINT', 'VSCODE_IPC_HOOK'])
      expect(options.env).not.toHaveProperty(name);
    expect(run.exitCode).toBeUndefined();
  });

  it('prefixes the runtime directory onto an absent PATH', async () => {
    vi.stubEnv('PATH', undefined);
    onTestFinished(() => vi.unstubAllEnvs());

    const run = await runScript(['launch']);

    expect(run.childProcess.spawnSync.mock.calls[0][2].env.PATH).toBe(
      `${join(runtimeRoot, 'node_modules', 'node', 'bin')}${delimiter}`,
    );
  });

  it('cleans upstream Git hooks after a failed install before exiting with its status', async () => {
    const run = await runScript(['install'], { spawnResults: [{ status: 7 }] });

    expect(run.exitCode).toBe(7);
    expect(run.stderr).toHaveBeenCalledWith('npm failed with status 7.');
    expect(run.events).toEqual([
      ['clean', repositoryRoot],
      ['spawn', 'npm', 'install'],
      ['clean', repositoryRoot],
    ]);
  });

  it('installs the pinned runtime before running a command when it is missing', async () => {
    const run = await runScript(['run', 'compile'], { missing: [nodeBinary] });

    expect(run.events).toEqual([
      ['clean', repositoryRoot],
      ['spawn', 'npm', 'install', '--prefix', runtimeRoot, 'node@22.0.0'],
      ['spawn', 'npm', 'run', 'compile'],
    ]);
    expect(run.childProcess.spawnSync.mock.calls[0][2]).toMatchObject({ cwd: repositoryRoot, env: process.env });
  });

  it('looks for the Windows runtime executable on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    onTestFinished(() => Object.defineProperty(process, 'platform', platform));

    const run = await runScript(['launch'], {
      missing: [join(runtimeRoot, 'node_modules', 'node', 'bin', 'node.exe')],
    });

    expect(run.events[1]).toEqual(['spawn', 'npm', 'install', '--prefix', runtimeRoot, 'node@22.0.0']);
  });

  it.each([
    [
      ['run', '--', 'watch', '--fast'],
      ['npm', 'run', 'watch', '--fast'],
    ],
    [
      ['run', 'watch', '--fast'],
      ['npm', 'run', 'watch', '--fast'],
    ],
    [
      ['launch', '--', '--verbose'],
      ['./scripts/code.sh', '--verbose'],
    ],
  ])('forwards %j to %j inside the generated checkout', async (argv, expected) => {
    const run = await runScript(argv);

    expect(run.events).toEqual([
      ['clean', repositoryRoot],
      ['spawn', ...expected],
    ]);
    expect(run.childProcess.spawnSync.mock.calls[0][2].cwd).toBe(sourceRoot);
  });

  it.each([
    [['bogus'], 'Unknown Code OSS command: bogus'],
    [[], 'Unknown Code OSS command: undefined'],
  ])('rejects the command %j', async (argv, message) => {
    const run = await runScript(argv);

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toHaveBeenCalledWith(message);
  });

  it('announces leaked hooks it removed', async () => {
    const run = await runScript(['launch'], { removedHooks: [['pre-commit', 'pre-push']] });

    expect(run.stdout).toHaveBeenCalledWith('Removed leaked Code OSS Git hooks: pre-commit, pre-push\n');
  });

  it('fails with the spawn error when a command cannot start', async () => {
    const run = await runScript(['launch'], { spawnResults: [{ error: new Error('spawn ENOENT') }] });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toHaveBeenCalledWith('spawn ENOENT');
  });

  it('exits with status 1 when a command ends without a status', async () => {
    const run = await runScript(['launch'], { spawnResults: [{ status: null }] });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toHaveBeenCalledWith('./scripts/code.sh failed with status null.');
  });

  it('fails when the checkout cannot be inspected', async () => {
    const run = await runScript(['launch'], { statError: Object.assign(new Error('denied'), { code: 'EACCES' }) });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toHaveBeenCalledWith('denied');
  });

  it('stringifies a non-Error failure', async () => {
    const run = await runScript(['launch'], { statError: 'inspection failed' });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toHaveBeenCalledWith('inspection failed');
  });
});
