import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { sourceEvidence } from '#scripts/security/source-evidence.mjs';
import SecurityReporter from '#scripts/security/reporter.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'glyph-source-evidence-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe('security source evidence', () => {
  it('records the real checkout revision and source fingerprint without copying source bytes', async () => {
    const result = await sourceEvidence(process.cwd());
    expect(result.revision).toMatch(/^[a-f0-9]{40}$/u);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.files.some(file => file.path === 'package.json')).toBe(true);
  });

  it('detects changed bytes, modes, deletions and symlink identity without following the link', async () => {
    const root = await fixture();
    await writeFile(join(root, 'source'), 'first');
    await symlink('missing-target', join(root, 'alias'));
    const git = vi.fn(
      /** @param {string} _command @param {string[]} args */ (_command, args) =>
        args[0] === 'rev-parse' ? 'fixture-revision\n' : 'source\0alias\0deleted\0source\0',
    );
    const before = await sourceEvidence(root, git);
    expect(before.files.map(file => file.path)).toEqual(['alias', 'deleted', 'source']);
    await writeFile(join(root, 'source'), 'second');
    const changed = await sourceEvidence(root, git);
    expect(changed.fingerprint).not.toBe(before.fingerprint);
    await chmod(join(root, 'source'), 0o700);
    expect((await sourceEvidence(root, git)).fingerprint).not.toBe(changed.fingerprint);
    await mkdir(join(root, 'directory'));
    git.mockImplementation((_command, args) => (args[0] === 'rev-parse' ? 'revision' : 'directory\0'));
    await expect(sourceEvidence(root, git)).rejects.toThrow();
  });

  it.each([false, true])('records evidence and rejects a changing source snapshot (changed=%s)', async changed => {
    const root = await fixture();
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ fingerprint: 'first' })
      .mockResolvedValueOnce({ fingerprint: changed ? 'second' : 'first' });
    const reporter = new SecurityReporter({ root, snapshot });
    await reporter.onTestRunStart();
    const completed = reporter.onTestRunEnd([], [], 'passed');
    if (changed) await expect(completed).rejects.toThrow('source files changed');
    else await completed;
    const evidence = JSON.parse(await readFile(join(root, '.artifacts/security/source.json'), 'utf8'));
    expect(evidence).toMatchObject({
      valid: !changed,
      runnerOutcome: 'passed',
      results: 'results.json',
      unhandledErrorCount: 0,
    });
  });

  it('defaults to the current checkout and production snapshotter', () => {
    const reporter = new SecurityReporter();
    expect(reporter.root).toBe(process.cwd());
    expect(reporter.snapshot).toBe(sourceEvidence);
  });
});
