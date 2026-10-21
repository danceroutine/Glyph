import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

async function runScript(argv, { playwright = '/upstream/@playwright/test/cli.js', missing = [] } = {}) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  const signals = new Map();
  const module = {
    createRequire: vi.fn(() => ({
      resolve: vi.fn(() => {
        if (!playwright) throw new Error('not found');
        return playwright;
      }),
    })),
  };
  const filesystem = {
    access: vi.fn(async url => {
      if (missing.some(file => url.href.endsWith(file))) throw new Error('missing');
    }),
  };
  const childProcess = { spawn: vi.fn(() => child) };
  const on = vi.spyOn(process, 'on').mockImplementation((signal, handler) => {
    signals.set(signal, handler);
    return process;
  });
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const originalArgv = process.argv;
  onTestFinished(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    on.mockRestore();
    stderr.mockRestore();
    vi.doUnmock('node:module');
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('node:child_process');
  });
  process.argv = ['node', 'test-electron.mjs', ...argv];
  vi.resetModules();
  vi.doMock('node:module', () => module);
  vi.doMock('node:fs/promises', () => filesystem);
  vi.doMock('node:child_process', () => childProcess);
  const loaded = import('#scripts/code-oss/test-electron.mjs');
  return { loaded, child, signals, module, filesystem, childProcess, stderr };
}

describe('test-electron', () => {
  it('requires the upstream Playwright installation', async () => {
    const run = await runScript([], { playwright: null });

    await expect(run.loaded).rejects.toThrow(
      'Code OSS Playwright is missing. Run pnpm code-oss:bootstrap and pnpm code-oss:install first.',
    );
    expect(run.module.createRequire.mock.calls[0][0].href).toMatch(/\/\.code-oss\/src\/package\.json$/);
  });

  it('requires the compiled workbench and packaged desktop host before running tests', async () => {
    const run = await runScript([], { missing: ['.artifacts/glyph-desktop-host/dist/desktop/host/utilityMain.js'] });

    await expect(run.loaded).rejects.toThrow(
      'Missing .artifacts/glyph-desktop-host/dist/desktop/host/utilityMain.js. Run pnpm desktop:artifact, pnpm code-oss:apply, and pnpm code-oss:compile first.',
    );
    expect(run.filesystem.access.mock.calls.map(([url]) => url.href.slice(url.href.indexOf('/.')))).toEqual([
      '/.code-oss/src/out/main.js',
      '/.artifacts/glyph-desktop-host/dist/desktop/host/utilityMain.js',
    ]);
    expect(run.childProcess.spawn).not.toHaveBeenCalled();
  });

  it.each([['--list'], ['--help']])('skips artifact checks for %s', async flag => {
    const run = await runScript([flag]);
    await run.loaded;

    expect(run.filesystem.access).not.toHaveBeenCalled();
    expect(run.childProcess.spawn.mock.calls[0][1]).toContain(flag);
  });

  it('runs the Playwright CLI with the pinned runtime and forwards arguments without separators', async () => {
    const run = await runScript(['--', 'GlyphChats.test.mjs', '--grep', 'chat']);
    await run.loaded;

    const [executable, arguments_, options] = run.childProcess.spawn.mock.calls[0];
    expect(executable).toBe(
      resolve(
        repositoryRoot,
        `.code-oss/node-runtime/node_modules/node/bin/${process.platform === 'win32' ? 'node.exe' : 'node'}`,
      ),
    );
    expect(arguments_).toEqual([
      '/upstream/@playwright/test/cli.js',
      'test',
      '--config',
      'code-oss/tests/electron/playwright.config.mjs',
      'GlyphChats.test.mjs',
      '--grep',
      'chat',
    ]);
    expect(options).toEqual({ cwd: `${repositoryRoot}/`, stdio: 'inherit', env: process.env });
  });

  it('uses the Windows runtime executable on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    onTestFinished(() => Object.defineProperty(process, 'platform', platform));

    const run = await runScript(['--list']);
    await run.loaded;

    expect(run.childProcess.spawn.mock.calls[0][0]).toMatch(/node_modules\/node\/bin\/node\.exe$/);
  });

  it('reports a runner that fails to start', async () => {
    const run = await runScript(['--list']);
    await run.loaded;

    run.child.emit('error', new Error('spawn EACCES'));

    expect(run.stderr).toHaveBeenCalledWith('spawn EACCES');
    expect(process.exitCode).toBe(1);
  });

  it.each([
    [0, 0],
    [3, 3],
    [null, 1],
  ])('exits with runner status %s as %s', async (code, expected) => {
    const run = await runScript(['--list']);
    await run.loaded;

    run.child.emit('exit', code);

    expect(process.exitCode).toBe(expected);
  });

  it.each(['SIGINT', 'SIGTERM'])('forwards %s to the runner', async signal => {
    const run = await runScript(['--list']);
    await run.loaded;

    run.signals.get(signal)();

    expect(run.child.kill).toHaveBeenCalledWith(signal);
  });
});
