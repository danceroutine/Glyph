import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** @param {{ incomplete: { file: string }[], directories?: string[] }} options */
async function runCheck({ incomplete, directories = ['.artifacts/coverage/v8/components'] }) {
  const originalArgv = process.argv;
  process.argv = ['node', 'check-coverage.mjs', ...directories];
  const empty = { statementMap: {}, fnMap: {}, branchMap: {}, s: {}, f: {}, b: {} };
  const baseline = { '/repo/a.ts': { path: '/repo/a.ts', ...empty }, '/repo/b.ts': { path: '/repo/b.ts', ...empty } };
  const processes = [{ result: [] }];
  const additions = { '/repo/a.ts': [] };
  const merged = { '/repo/a.ts': { merged: true }, '/repo/b.ts': { merged: true } };
  const filesystem = {
    readFile: vi.fn(async () => JSON.stringify(baseline)),
    rm: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
  };
  const recording = { readProcessCoverage: vi.fn(async () => processes) };
  const conversion = {
    convertProcessCoverage: vi.fn(async () => additions),
    mergeOntoBaseline: vi.fn(() => merged),
    findIncompleteFiles: vi.fn(() => incomplete),
  };
  const coverageMap = { files: () => [] };
  const context = { context: true };
  /** @type {{ name: string, options: unknown, execute: ReturnType<typeof vi.fn> }[]} */
  const reporters = [];
  const libCoverage = { createCoverageMap: vi.fn(() => coverageMap) };
  const libReport = { createContext: vi.fn(() => context) };
  const reports = {
    create: vi.fn((name, options) => {
      const reporter = { name, options, execute: vi.fn() };
      reporters.push(reporter);
      return reporter;
    }),
  };
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  onTestFinished(() => {
    process.argv = originalArgv;
    stderr.mockRestore();
    process.exitCode = undefined;
    vi.doUnmock('node:fs/promises');
    vi.doUnmock('#scripts/coverage/record-coverage.mjs');
    vi.doUnmock('#scripts/coverage/v8-coverage.mjs');
    vi.doUnmock('istanbul-lib-coverage');
    vi.doUnmock('istanbul-lib-report');
    vi.doUnmock('istanbul-reports');
  });
  vi.resetModules();
  vi.doMock('node:fs/promises', () => filesystem);
  vi.doMock('#scripts/coverage/record-coverage.mjs', () => recording);
  vi.doMock('#scripts/coverage/v8-coverage.mjs', () => conversion);
  vi.doMock('istanbul-lib-coverage', () => ({ default: libCoverage }));
  vi.doMock('istanbul-lib-report', () => ({ default: libReport }));
  vi.doMock('istanbul-reports', () => ({ default: reports }));
  await import('#scripts/coverage/check-coverage.mjs');
  const exitCode = process.exitCode;
  return {
    baseline,
    processes,
    additions,
    merged,
    filesystem,
    recording,
    conversion,
    coverageMap,
    context,
    reporters,
    libCoverage,
    libReport,
    stderr,
    exitCode,
  };
}

describe('check-coverage', () => {
  it('requires explicit inputs rather than reading stale coverage', async () => {
    await expect(runCheck({ incomplete: [], directories: [] })).rejects.toThrow('Pass the coverage directories');
  });

  it('merges both requested directories for the full run', async () => {
    const run = await runCheck({ incomplete: [], directories: ['components', 'electron'] });
    expect(run.recording.readProcessCoverage.mock.calls).toEqual([
      [join(repositoryRoot, 'components')],
      [join(repositoryRoot, 'electron')],
    ]);
    expect(run.conversion.convertProcessCoverage.mock.calls[0][0]).toEqual([...run.processes, ...run.processes]);
  });

  it('merges recorded process coverage onto the Vitest baseline and writes every report', async () => {
    const run = await runCheck({ incomplete: [] });

    expect(run.filesystem.readFile).toHaveBeenCalledWith(
      join(repositoryRoot, 'coverage', 'vitest', 'coverage-final.json'),
      'utf8',
    );
    expect(run.recording.readProcessCoverage).toHaveBeenCalledExactlyOnceWith(
      join(repositoryRoot, '.artifacts', 'coverage', 'v8', 'components'),
    );
    expect(run.conversion.convertProcessCoverage).toHaveBeenCalledWith(run.processes, {
      repositoryRoot,
      files: new Set(['/repo/a.ts', '/repo/b.ts']),
    });
    expect(run.conversion.mergeOntoBaseline).toHaveBeenCalledWith(run.baseline, run.additions);
    expect(run.filesystem.rm).toHaveBeenCalledWith(join(repositoryRoot, 'coverage', 'merged'), {
      recursive: true,
      force: true,
    });
    expect(run.filesystem.mkdir).toHaveBeenCalledWith(join(repositoryRoot, 'coverage', 'merged'), { recursive: true });
    expect(run.filesystem.writeFile).toHaveBeenCalledWith(
      join(repositoryRoot, 'coverage', 'merged', 'coverage-final.json'),
      JSON.stringify(run.merged),
    );
    expect(run.libCoverage.createCoverageMap).toHaveBeenCalledWith(run.merged);
    expect(run.libReport.createContext).toHaveBeenCalledWith({
      dir: join(repositoryRoot, 'coverage', 'merged'),
      coverageMap: run.coverageMap,
    });
    expect(run.reporters.map(({ name, options }) => [name, options])).toEqual([
      ['html', undefined],
      ['json-summary', undefined],
      ['text', { skipFull: true }],
      ['text-summary', undefined],
    ]);
    for (const reporter of run.reporters) expect(reporter.execute).toHaveBeenCalledWith(run.context);
    expect(run.conversion.findIncompleteFiles).toHaveBeenCalledWith(run.merged);
  });

  it('leaves the exit status untouched when every file is fully covered', async () => {
    const run = await runCheck({ incomplete: [] });

    expect(run.exitCode).toBeUndefined();
    expect(run.stderr).not.toHaveBeenCalled();
  });

  it('fails with a count of incomplete files when any file falls short', async () => {
    const run = await runCheck({ incomplete: [{ file: '/repo/a.ts' }] });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toHaveBeenCalledWith('1 of 2 files are below 100% coverage.\n');
  });
});
