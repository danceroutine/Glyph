import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect, vi, onTestFinished } from 'vitest';
import { SkillRepositoryGit } from '../SkillRepositoryGit.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'glyph-git-budget-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
it('rejects a repository object store over budget before starting another object fetch', async () => {
  const root = await fixture();
  await writeFile(join(root, 'objects.pack'), Buffer.alloc(32 * 1024 * 1024 + 1));
  await expect(new SkillRepositoryGit(root, new AbortController().signal).run(['version'])).rejects.toThrow('32 MiB');
});
it.skipIf(process.platform === 'win32')(
  'terminates Git transport helpers and settles cancellation before returning',
  async () => {
    const root = await fixture();
    const binary = await fixture();
    await writeFile(join(binary, 'git'), '#!/bin/sh\nsleep 30 &\necho $! > helper-pid\nwait\n', { mode: 0o700 });
    vi.stubEnv('PATH', binary + delimiter + process.env.PATH);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const cancel = new AbortController();
    const result = new SkillRepositoryGit(root, cancel.signal).run(['version']);
    let helper = 0;
    await vi.waitFor(async () => {
      helper = Number(await readFile(join(root, 'helper-pid'), 'utf8'));
      expect(helper).toBeGreaterThan(0);
    });
    cancel.abort(new Error('Read cancelled'));
    await expect(result).rejects.toThrow('Read cancelled');
    await vi.waitFor(() => {
      expect(() => process.kill(helper, 0)).toThrow();
    });
  },
);
it('bounds each Git object read and propagates missing-command diagnostics', async () => {
  const root = await fixture();
  const git = new SkillRepositoryGit(root, new AbortController().signal);
  await expect(git.run(['--version'], 2)).rejects.toThrow('output budget');
  await expect(git.run(['missing-glyph-test-subcommand'])).rejects.toThrow('missing-glyph-test-subcommand');
});
