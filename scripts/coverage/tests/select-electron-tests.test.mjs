import { describe, expect, it, onTestFinished, vi } from 'vitest';

async function run({ base = 'origin/main', output, environment = false, unavailable = false, empty = false } = {}) {
  const argv = process.argv;
  process.argv = [
    'node',
    'select-electron-tests.mjs',
    ...(base ? ['--base', base] : []),
    ...(output ? ['--output', output] : []),
  ];
  vi.stubEnv('GITHUB_OUTPUT', environment ? '/outputs' : '');
  vi.stubEnv('GITHUB_STEP_SUMMARY', environment ? '/summary' : '');
  const filesystem = {
    readFile: vi.fn(async () =>
      JSON.stringify({ rules: [{ area: 'web', prefixes: ['src/web/'], tests: ['GlyphWeb'] }] }),
    ),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    appendFile: vi.fn(),
  };
  const execFileSync = vi.fn((/** @type {string} */ _file, /** @type {string[]} */ args) => {
    switch (args[0]) {
      case 'ls-files':
        return empty ? '' : 'code-oss/tests/electron/GlyphWeb.test.mjs\0code-oss/tests/electron/GlyphTodos.test.mjs\0';
      case 'rev-parse':
        if (unavailable) throw new Error('missing base');
        return 'base-sha\n';
      case 'merge-base':
        return 'merge-base-sha\n';
      case 'diff':
        return 'src/web/a file.ts\0';
      default:
        throw new Error('unexpected git command');
    }
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  onTestFinished(() => {
    process.argv = argv;
    vi.unstubAllEnvs();
    stdout.mockRestore();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs/promises');
  });
  vi.resetModules();
  vi.doMock('node:child_process', () => ({ execFileSync }));
  vi.doMock('node:fs/promises', () => filesystem);
  await import('#scripts/coverage/select-electron-tests.mjs');
  return {
    selection: /** @type {{ mode: string, tests: string[] }} */ (JSON.parse(stdout.mock.calls[0][0])),
    filesystem,
    execFileSync,
  };
}

describe('selection CLI', () => {
  it('uses the merge base and NUL-delimited paths, including spaces', async () => {
    const { selection, execFileSync } = await run();
    expect(selection).toMatchObject({
      mode: 'selected',
      mergeBase: 'merge-base-sha',
      tests: ['code-oss/tests/electron/GlyphWeb.test.mjs'],
    });
    expect(execFileSync.mock.calls.map(call => call[1])).toEqual([
      ['ls-files', '-z', 'code-oss/tests/electron/*.test.mjs'],
      ['rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}'],
      ['merge-base', 'HEAD', 'base-sha'],
      ['diff', '--name-only', '--no-renames', '-z', 'merge-base-sha', 'HEAD', '--'],
    ]);
  });

  it('writes the reviewed selection artifact and GitHub outputs', async () => {
    const { selection, filesystem } = await run({ output: '.artifacts/selection.json', environment: true });
    expect(filesystem.mkdir).toHaveBeenCalled();
    expect(JSON.parse(filesystem.writeFile.mock.calls[0][1])).toEqual(selection);
    expect(filesystem.appendFile).toHaveBeenCalledWith('/outputs', 'mode=selected\ncount=1\n');
    expect(filesystem.appendFile.mock.calls[1][1]).toContain('    "mode": "selected"');
  });

  it.each([{ base: '' }, { unavailable: true }])(
    'falls back to full when history is unavailable: %j',
    async options => {
      const { selection } = await run(options);
      expect(selection.mode).toBe('full');
      expect(selection.tests).toHaveLength(2);
    },
  );

  it('fails when test discovery is empty instead of silently skipping', async () => {
    await expect(run({ empty: true })).rejects.toThrow('No Electron suites found');
  });
});
